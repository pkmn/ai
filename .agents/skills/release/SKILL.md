---
name: release
description: >-
  Audit a GitHub repository (e.g. `/release https://github.com/owner/repo` or
  `/release owner/repo`) against the pkmn.ai Responsible Release guidelines in
  `static/release.dj`. Checks HEAD, other branches, GitHub Releases, external
  download links, and git history for discouraged artifacts (turnkey solutions,
  model weights, training harnesses, self-play trajectories/datasets, live-game
  analysis tools, and Pokémon Showdown integration) and reports concrete evidence
  and remediation steps.
---

# Responsible Release Audit (`/release`)

Read-only audit runbook for evaluating whether a public GitHub repository complies with
[static/release.dj](../../../static/release.dj) (`https://pkmn.ai/release`).

**Golden rules:**
- **Always read [static/release.dj](../../../static/release.dj) first** — the policy is
  explicitly expected to evolve over time; never rely solely on memory.
- **Verify file contents before flagging.** Never flag a file on filename alone (e.g. a
  `showdown.py` might only parse replays; `model.py` may be pure architecture; `--watch`
  may be a spectator viewer rather than a human live advisor).
- **Never blindly `git clone` a repository before checking its size** — unredacted ML repos
  frequently contain hundreds of MB or multi-GB of checkpoints/datasets. Use `gh api`
  first and `--filter=blob:none` if cloning for git-history inspection.
- **Keep the workspace clean.** Put any temporary clones or scratch files under the
  conversation artifact scratch directory (`<scratch>/release-<owner>-<repo>/`), never
  inside the `pkmn/ai` repository.
- **Quote query strings in zsh:** Always single-quote `gh api` paths containing `?`
  (e.g. `'repos/<owner>/<repo>/git/trees/HEAD?recursive=1'`) so zsh does not attempt glob
  expansion.

---

## Phase 0 — Read Policy & Gather Repo Metadata

1. Read [static/release.dj](../../../static/release.dj) to confirm the current allowed vs.
   discouraged artifact categories and redaction rules.
2. Parse `<owner>/<repo>` (and optional ref/branch) from the user's URL or shorthand
   (strip trailing `.git`, `/tree/...`, `/blob/...`).
3. Collect repository metadata, branches, tags, GitHub Releases, and the full `HEAD` file
   tree via `gh api`:

```sh
REPO="<owner>/<repo>"
gh api "repos/$REPO" --jq '{
  url: .html_url,
  default_branch,
  size_kb: .size,
  archived,
  fork,
  license: .license.spdx_id,
  created_at,
  pushed_at,
  description
}'
gh api "repos/$REPO/branches?per_page=100" --jq '.[].name'
gh api "repos/$REPO/tags?per_page=100" --jq '.[].name'
gh api "repos/$REPO/releases?per_page=30" --jq '.[] | {tag_name, name, draft, assets: [.assets[] | {name, size, url: .browser_download_url}]}'
gh api "repos/$REPO/git/trees/HEAD?recursive=1" --jq '.tree[] | "\(.type)\t\(.size // 0)\t\(.path)"'
```

*(If `truncated: true` on the recursive tree, fall back to a blobless clone in Phase 1.7.)*

---

## Phase 1 — Audit Every Category in `static/release.dj`

Inspect `README.md`, key entrypoints, scripts, docs, and suspect files via
`gh api "repos/$REPO/contents/<path>" --jq '.content' | base64 --decode` (or from a
blobless checkout if many files need searching).

### 1. Model Weights (`HEAD`, Branches, Releases, External Hosts, History)
- **In-tree artifacts:** Flag trained checkpoints and large binary blobs in the tree:
  - Common extensions: `.pt`, `.pth`, `.ckpt`, `.onnx`, `.safetensors`, `.bin`, `.weights`,
    `.h5`, `.hdf5`, `.keras`, `.pb`, `.tflite`, `.pkl`, `.joblib`, `.msgpack`, `.gguf`,
    `.params`, `.model`, `.nnue`, or weight archives (`.tar*`, `.zip`, `.7z`).
  - Large files (`>= 1 MB`) and Git LFS pointers (check `.gitattributes` and any small
    pointer files with `version https://git-lfs.github.com/spec/v1`).
- **GitHub Releases & external weight links:** Inspect release assets, `README.md`, and
  download scripts (`get_models*`, `download*`, `Makefile`, `Dockerfile`) for links to
  Hugging Face (`huggingface.co`, `hf_hub_download`, `from_pretrained`), Google Drive
  (`drive.google.com`, `gdown`), S3/GCS/R2, Dropbox/Mega, Zenodo/Figshare, or another
  repo's GitHub Releases. Verify whether external links are live (`curl -sI` or `gh api`)
  rather than assuming.
- **Distinguish allowed data:** Static game-engine lookup tables (`tables.json`),
  human usage/set statistics, or pure vocabularies are not model weights.

### 2. Pokémon Showdown Integration
- Search for live Showdown client / server connectors:
  - Live hosts & login: `play.pokemonshowdown.com`, `sim3.psim.us`, `sim.smogon.com`,
    `psim.us`, `ShowdownServerConfiguration`, `loginserver`, `PS_PASSWORD`,
    `/challenge`, `/search`, `/accept`, `ladder`, `accept_challenges`, `send_challenges`.
  - Client libraries & bot runners: `poke-env` / `poke_env` live players, WebSocket
    Showdown clients, `scripts/bot.sh`, `ladder*.py`, Showdown browser userscripts.
- **Distinguish allowed vs. discouraged:**
  - Read the actual files to separate **live Showdown integration** (laddering,
    challenging, accepting challenges, connecting to `play.pokemonshowdown.com` or a PS
    server as an agent) from **local simulation / offline replay parsing** (using
    `@pkmn/sim` or parsing static `.log`/replay JSONs without a Showdown client).
  - Be explicit about what each flagged file does (public server vs. local Showdown
    server bridge).

### 3. Turnkey Solutions
- Assess whether someone can clone the repo and run an end-to-end playing agent with
  minimal effort (e.g. `README.md` quickstart, `Dockerfile`, CLI scripts in
  `pyproject.toml`/`package.json`, `scripts/*.sh`).
- Flag when inference/search, weights (committed or auto-downloaded), team pools, and
  a Showdown runner are bundled together into a ready-to-run agent.

### 4. Training Harnesses
- Look for imitation/RL/self-play training pipelines and job orchestration:
  - Training loops: `train*.py`, `rl*.py`, `ppo*.py`, `dqn*`, `rnad*`, `selfplay*`,
    `self_play*`, `alphazero*`, `distill*`, `exit.py`, `double_oracle*`,
    `dataset.py` (training-tensor builders), `collect*` / `rollout*`.
  - Cluster/experiment launch harnesses: `scripts/slurm/`, Ray/Hydra/Accelerate training
    configs, end-to-end training shell scripts.
- **Distinguish allowed infrastructure:** Standalone network architecture definitions
  (`model.py`), state encoders (`encode.py`), search infrastructure (`search.py`, MCTS,
  alpha-beta), and fast game engines/simulators are **allowed** under `release.dj`
  (*"game engines, network / search infrastructure"*). Only flag actual training loops,
  self-play collectors, and training orchestration harnesses.

### 5. Self-Play Trajectories & Training Datasets
- Check for committed or externally linked self-play logs, replay buffers, trajectory
  shards, or preprocessed ML training tensors (`.npz`, `.npy`, `.parquet`, `.arrow`,
  `.tfrecord`, `.jsonl`, `.zst`, `.h5`, Hugging Face dataset links).
- **Distinguish allowed datasets:** Human replay archives, human team pools/pastes, and
  public usage statistics (e.g. Smogon/Showdown replays, VGC pastes, MunchStats) are
  **allowed** (*"human replay / team databases"*). Flag self-play trajectories and
  ML-ready training datasets.

### 6. Live-Game Analysis Tools
- Check for browser extensions (`manifest.json` matching `play.pokemonshowdown.com`),
  Tampermonkey/Greasemonkey userscripts, live overlays, or tools that read an active
  human battle to recommend moves/switches/winrates/hidden-set beliefs in real time.
- **Distinguish allowed tools:** Hosted or offline *post-game* replay analyzers, match
  summaries, and rating plots are **allowed** (*"hosted post-game analysis tools"*).
  A local spectator viewer that only renders the agent's own games is not a human
  live-game advisor — describe it accurately.

### 7. Version-Control History, Non-Default Branches & Redaction Hygiene
`static/release.dj` specifically requires that redacted artifacts **cannot be recovered
from version control history**. Always check beyond `HEAD`:

1. **Compare `HEAD` blob sum vs. repo `size_kb`:** If `size_kb` is substantially larger
   than the sum of `HEAD` file sizes, large artifacts (weights, datasets, archives) almost
   certainly live in git history or other branches.
2. **Inspect other branches and tags** if any exist (`gh api "repos/$REPO/git/trees/<branch>?recursive=1"`).
3. **Audit git history for deleted or leaked artifacts** using a lightweight blobless
   bare clone (never downloads huge blobs) in `<scratch>/release-<owner>-<repo>/`:

```sh
SCRATCH="<scratch>/release-$(echo "$REPO" | tr '/' '-')"
mkdir -p "$SCRATCH"
git clone --bare --filter=blob:none "https://github.com/$REPO.git" "$SCRATCH/repo.git"

# Check deleted files across all branches/tags for weights, datasets, training, or PS scripts
git -C "$SCRATCH/repo.git" log --all --diff-filter=D --summary --oneline \
  | grep -iE '\.(pt|pth|ckpt|onnx|safetensors|bin|weights|h5|pkl|npz|npy|parquet|tar|zip|7z)|showdown|ladder|train|rl|selfplay|bot\.' \
  | head -n 60

# Check commits touching model/checkpoint/weight/data paths
git -C "$SCRATCH/repo.git" rev-list --objects --all \
  | grep -iE '\.(pt|pth|ckpt|onnx|safetensors|bin|weights|h5|pkl|npz|npy|parquet|gguf|nnue)$' \
  | head -n 60
```

4. Watch for accidental nested copies of redacted directories (e.g. a stale copy of `src/`
   or `scripts/` left inside `data/`).
5. Check whether `README.md` includes the optional Responsible Release redaction notice
   from `static/release.dj` (mention only if relevant; omitting it is not a violation).

---

## Phase 2 — Present Concise Verdict & Report

Deliver a clear, evidence-backed report structured as follows:

1. **Verdict (first line):** **Yes** (compliant), **No** (non-compliant), or
   **Partial / Borderline**, with a one-sentence summary referencing
   [release.dj](../../../static/release.dj).
2. **Violated guidelines** (omit if fully compliant):
   - Group by the exact `release.dj` categories (*Model weights*, *Pokémon Showdown
     integration*, *Turnkey solution*, *Training harnesses*, *Self-play trajectories /
     training datasets*, *Live-game analysis tools*).
   - Cite concrete evidence: exact file paths, file sizes, branch/tag names, GitHub
     Release asset names, verified external URLs, and commit SHAs for git-history leaks.
3. **Compliant / not present:**
   - Note which discouraged categories were checked and not found.
   - Briefly list the project's reasonable-to-share components (writeups, engines,
     network/search code, human replay/team databases, post-game tools).
4. **Remediation summary** (if non-compliant):
   - Concise, actionable list of what needs to be removed or separated — explicitly calling
     out fresh/rewritten git history (or deleting offending releases/branches) whenever
     artifacts exist in history, and noting the optional `README.md` policy notice.
