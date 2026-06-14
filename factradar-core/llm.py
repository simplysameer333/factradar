"""Single provider-agnostic LLM entry point (FR-LLM-01).

Switch backends by env var only, no pipeline code changes (FR-LLM-04):
  LLM_BACKEND=ollama   -> local, free
  LLM_BACKEND=claude   -> Anthropic Claude API (needs ANTHROPIC_API_KEY)
  LLM_BACKEND=openai   -> OpenAI API (needs OPENAI_API_KEY)
"""

import os
from langchain_core.language_models.chat_models import BaseChatModel


def get_llm() -> BaseChatModel:
    backend = os.getenv("LLM_BACKEND", "ollama").lower()

    if backend == "openai":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0,
            timeout=60,
        )  # reads OPENAI_API_KEY from env

    if backend == "claude":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model=os.getenv("CLAUDE_MODEL", "claude-haiku-4-5-20251001"),
            temperature=0,
            timeout=60,
        )  # reads ANTHROPIC_API_KEY from env

    # default: local Ollama
    from langchain_ollama import ChatOllama

    return ChatOllama(
        model=os.getenv("OLLAMA_MODEL", "llama3.1"),
        base_url=os.getenv("OLLAMA_URL", "http://localhost:11434"),
        temperature=0,
    )
