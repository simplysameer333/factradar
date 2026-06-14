"""The LangGraph fact-check pipeline (FR-VRD-06).

Flow:  check-worthiness --(yes)--> extract claim --> retrieve evidence --> verdict
                          --(no)---> END (skip, no reply)
"""

import json
from typing import TypedDict, List

from langchain_core.messages import SystemMessage, HumanMessage
from langgraph.graph import StateGraph, END

from llm import get_llm
from retrieval import web_search, fact_check_api


# Cap how many claims we actually fact-check per message (cost + message length).
MAX_CLAIMS = 5


class State(TypedDict, total=False):
    text: str
    is_media: bool
    source_type: str  # text | image | video | audio
    check_worthy: bool
    claims: List[str]
    claims_truncated: bool  # True when the source had more claims than MAX_CLAIMS
    # one entry per claim: {claim, factchecks, evidence, verdict}
    results: List[dict]


def _ask(llm, system: str, user: str) -> str:
    resp = llm.invoke([SystemMessage(content=system), HumanMessage(content=user)])
    return getattr(resp, "content", str(resp))


def node_check_worthy(state: State, llm) -> State:
    # Media that yielded substantial text (OCR/transcript) is always worth checking:
    # the LLM gate is meant to filter text chit-chat, and small local models are
    # unreliable judges of noisy OCR. Photos without text never reach the pipeline.
    if state.get("is_media") and len(state.get("text", "")) >= 25:
        state["check_worthy"] = True
        return state

    out = _ask(
        llm,
        "You decide whether a WhatsApp message contains a verifiable factual claim. "
        "The text may be noisy OCR from an image or a rough transcript - ignore stray "
        "symbols and judge the substance. Check-worthy (YES) includes: claims about "
        "events, health, science, or statistics; and quotes attributed to real people "
        "(whether someone actually said it is verifiable). Greetings, personal "
        "opinions, jokes, and chit-chat are NO. Reply with exactly YES or NO.",
        state.get("text", ""),
    )
    state["check_worthy"] = out.strip().upper().startswith("Y")
    return state


_SOURCE_CONTEXT = {
    "image": "The text below was OCR-extracted from an image (meme/screenshot/infographic) "
             "and may contain watermark or layout noise — ignore the noise.",
    "video": "The text below combines a speech transcript and on-screen text from a video "
             "and may contain transcription errors — judge the substance.",
    "audio": "The text below is a voice-note transcript and may contain transcription errors.",
    "text": "The text below is a WhatsApp text message.",
}


def node_extract(state: State, llm) -> State:
    context = _SOURCE_CONTEXT.get(state.get("source_type", "text"), _SOURCE_CONTEXT["text"])
    out = _ask(
        llm,
        f"{context}\n"
        "Analyse ALL of it and break it into SEGMENTS: every distinct verifiable "
        "factual claim is its own segment — each attributed quote, statistic, event "
        "statement, or health/science assertion separately. A quote meme with two "
        "speakers has at least two segments; never merge different speakers' "
        "statements into one claim. Rewrite each segment as a short, self-contained, "
        "searchable sentence; resolve vague references where possible. ORDER the claims "
        "by importance — the most significant and most check-worthy first. Return up to "
        '10. Respond as STRICT JSON only: {"claims": ["...", "..."]}. No text outside the JSON.',
        state.get("text", ""),
    )
    parsed = _parse_json(out)
    claims = [c.strip() for c in (parsed.get("claims") or []) if isinstance(c, str) and c.strip()]
    # Check only the top-N most important; flag if the source had more.
    state["claims_truncated"] = len(claims) > MAX_CLAIMS
    state["claims"] = claims[:MAX_CLAIMS] or [state.get("text", "").strip()]
    return state


def node_retrieve(state: State) -> State:
    results = []
    for claim in state.get("claims", []):
        results.append(
            {
                "claim": claim,
                "factchecks": fact_check_api(claim),
                "evidence": web_search(claim, k=5),
            }
        )
    state["results"] = results
    return state


_VERDICT_SYS = (
    "You are a careful fact-checker. Using ONLY the supplied evidence and existing "
    "fact-checks, judge the claim. Choose a label from: True, False, Misleading, Unverified.\n"
    "Source credibility guides your confidence — judge each source before believing it. Tiers:\n"
    "  STRONG: wire agencies (Reuters, AP, AFP), major broadsheets/broadcasters (BBC, "
    "Guardian, NYT, WSJ, FT, etc.), dedicated fact-checkers (Snopes, Full Fact, "
    "PolitiFact, AFP Fact Check), peer-reviewed journals, government/court/official "
    "records and primary transcripts.\n"
    "  WEAK: anonymous or unfamiliar blogs, SEO 'content farms', celebrity-gossip and "
    "tech-rumour aggregator sites, AI-generated listicles, sites with a clear commercial "
    "or political stake, and any domain you do not recognise as an established outlet.\n"
    "CONFIDENCE RULES (balanced):\n"
    "- At least one STRONG source supports the conclusion -> True/False with confidence 75-95.\n"
    "- No STRONG source, but TWO OR MORE INDEPENDENT sources agree (different owners/domains, "
    "genuinely separate reports — NOT the same article copied around) -> you MAY label it "
    "True/False with MODERATE confidence 60-72. Treat niche, new, specialist or "
    "product/tech topics this way: real but small-scale events are often covered only by "
    "smaller outlets first, so consistent independent coverage counts as corroboration.\n"
    "- Only a SINGLE weak source, OR several that are clearly one story copied around, OR "
    "sources that conflict -> Unverified with confidence <= 40 (one obscure site, or copies "
    "of it, are not evidence something is real).\n"
    "Fabricated-quote rule: genuine sensational statements by prominent public figures "
    "(politicians, celebrities, officials) are always widely reported. If the claim "
    "attributes a quote to such a figure, the web evidence contains real search results, and "
    "NO source (strong, or multiple independent) corroborates it, label it False (fabricated "
    "or misattributed) with confidence 70-90 — absence of coverage IS the evidence there.\n"
    "Use Unverified when: the search results are empty or contain errors (retrieval failed — "
    "never treat that as absence of coverage); only a single weak source supports the claim; "
    "the subject is too obscure to judge; or credible sources genuinely conflict.\n"
    "When sources disagree, side with the stronger tier and say which sources you trusted. "
    "List the most credible sources FIRST in 'sources', and do not pad with weak links.\n"
    "Rationale: maximum 3 short plain-language sentences — what the evidence shows, the "
    "credibility of the sources behind it, and why that leads to the label. "
    'Respond as STRICT JSON only: {"label": "...", "confidence": 0-100, '
    '"rationale": "max 3 sentences", "sources": ["url", ...]}. No text outside the JSON.'
)


def node_verdict(state: State, llm) -> State:
    for r in state.get("results", []):
        payload = {
            "claim": r["claim"],
            "existing_fact_checks": r["factchecks"],
            "web_evidence": r["evidence"],
        }
        raw = _ask(llm, _VERDICT_SYS, json.dumps(payload, ensure_ascii=False)[:8000])
        verdict = _parse_json(raw)
        if not verdict.get("sources"):
            # never deliver a verdict without references: fall back to what we retrieved
            urls = [f.get("url") for f in r["factchecks"]] + [e.get("url") for e in r["evidence"]]
            verdict["sources"] = [u for u in urls if u][:3]
        r["verdict"] = verdict
    return state


def _parse_json(raw: str) -> dict:
    raw = raw.strip().strip("`")
    try:
        start, end = raw.find("{"), raw.rfind("}")
        return json.loads(raw[start : end + 1])
    except Exception:
        return {
            "label": "Unverified",
            "confidence": 0,
            "rationale": "Could not parse a verdict from the model output.",
            "sources": [],
        }


def build_graph():
    llm = get_llm()
    g = StateGraph(State)
    g.add_node("check", lambda s: node_check_worthy(s, llm))
    g.add_node("extract", lambda s: node_extract(s, llm))
    g.add_node("retrieve", node_retrieve)
    g.add_node("verdict", lambda s: node_verdict(s, llm))

    g.set_entry_point("check")
    g.add_conditional_edges("check", lambda s: "extract" if s.get("check_worthy") else END)
    g.add_edge("extract", "retrieve")
    g.add_edge("retrieve", "verdict")
    g.add_edge("verdict", END)
    return g.compile()
