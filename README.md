# Chorus

> WARNING: Early in development stage.

Cinematic dialogue engine. The AI Game Master generates branching narrative through tool-calling, streamed to a console client in real-time via SSE. Player choices are guided by twelve inner voices — each a distinct personality mapped to a character stat — with skill checks resolved through 2D6 dice rolls.

No plan for web UI for now. Focus only on storytelling quality.

## Getting Started

### Prerequisites

- Node.js 26+
- [llama-server](https://github.com/ggml-org/llama.cpp) (for embeddings and reranking)
- A DeepSeek API key.

### Model Setup

Download the GGUF models into `data/models/`:

```bash
# Qwen3-Embedding
wget -P data/models/ https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf

# Qwen3-Reranker
wget -P data/models/ https://huggingface.co/Qwen/Qwen3-Reranker-0.6B-GGUF/resolve/main/Qwen3-Reranker-0.6B-Q8_0.gguf
```

### Setup

```bash
cp .env.example .env
# Add your keys to .env:
#   DEEPSEEK_API_KEY=your_key_here
#
# Llama-server endpoints (defaults work with default ports):
#   LLAMA_EMBED_URL=http://localhost:8080/v1/embeddings
#   LLAMA_RERANK_URL=http://localhost:8081/v1/rerank
#   EMBEDDING_DIMENSIONS=1024

npm install

# Terminal 1 — Embedding server
llama-server -m data/models/Qwen3-Embedding-0.6B-Q8_0.gguf --port 8080 -c 32768 -ngl 99 --embeddings

# Terminal 2 — Reranker server (optional; improves search precision)
llama-server -m data/models/Qwen3-Reranker-0.6B-Q8_0.gguf --port 8081 -c 32768 -ngl 99 --reranking

# Terminal 3 — Express server
npm run server

# Terminal 4 — Play
npm run console
```

## Developer Documentation

See [DEVELOPER.md](DEVELOPER.md) for configuration and architecture details.

## License

[AGPL v3](./LICENSE)
