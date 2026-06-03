## THINGS TO KEEP IN MIND

- If `// TODO:`, `// WARNING:` or `// NOTE:` is found in code, preserve it.
- No need to add license header for new files, user will add it manually.
- No need to consider backward compatibility (anything including database), we always start fresh.
- If you meet a problem regarding to Cypher usage in LadybugDB, check CYPHER.md in the project root.
- Always use `Bash` tool and bash scripts.

## IMPORTANT: Your workflow

1. **Read DEVELOPER.md BEFORE DOING ANYTHING ELSE**. DEVELOPER.md may contain outdated information, so it should only act as a reference. Check the exact source files before you act.
2. Explore the codebase, making plans, modify codebase, etc.
3. Update DEVELOPER.md after you have modified the codebase, keep concise.

## GUIDELINES

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- Focus on **MODULARITY** and **EXTENSIBILITY**. Avoid type redefinition and magic strings. Do not let one file grows too big (>700 lines).
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
