"""Evidence retrieval (FR-EVD): free web search + existing published fact-checks."""

import os
import httpx


def web_search(query: str, k: int = 5) -> list[dict]:
    results: list[dict] = []
    try:
        try:
            from ddgs import DDGS  # newer package name
        except ImportError:
            from duckduckgo_search import DDGS  # older name
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=k):
                results.append(
                    {
                        "title": r.get("title"),
                        "url": r.get("href") or r.get("url"),
                        "snippet": r.get("body"),
                    }
                )
    except Exception as e:  # never let search failure crash the pipeline
        results.append({"error": str(e)})
    return results


def fact_check_api(query: str) -> list[dict]:
    """Google Fact Check Tools API — returns ClaimReview matches. Free with an API key."""
    key = os.getenv("FACTCHECK_API_KEY")
    if not key:
        return []
    try:
        r = httpx.get(
            "https://factchecktools.googleapis.com/v1alpha1/claims:search",
            params={"query": query, "key": key, "languageCode": "en"},
            timeout=20,
        )
        r.raise_for_status()
        out: list[dict] = []
        for c in r.json().get("claims", [])[:5]:
            review = (c.get("claimReview") or [{}])[0]
            out.append(
                {
                    "claim": c.get("text"),
                    "publisher": (review.get("publisher") or {}).get("name"),
                    "rating": review.get("textualRating"),
                    "url": review.get("url"),
                }
            )
        return out
    except Exception as e:
        return [{"error": str(e)}]
