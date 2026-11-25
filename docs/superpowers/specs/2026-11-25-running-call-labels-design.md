# Running call labels

## Intent

While an agent runs a command, the dashboard says little more than "Running Bash", "Running Agent › Bash" or "Waiting
on 1 command". Claude Code already gives us the sentence the agent wrote for each call (the Bash `description`, the
name of each background command). Show that sentence, with no added words around it.

Non-goals: live output, PIDs, CPU or memory, a separate list of running commands.

## Approaches

- Command line after the tool name ("Running Bash bun test …"): too long, and the row above already shows the command.
- The agent's own sentence alone ("Run affected tests"): loses where it runs; inside an agent it repeated the agent's
  row word for word.
- **Picked:** the tool chain, then the sentence: `Agent › Agent › Bash: Run affected tests`. `|>` as the separator was
  considered and dropped; `›` is what the line already uses.

## Design

**The line under a running turn** (`activity()` in `src/dashboard/ui/thread-model.ts`), for a running call:

- The tool names from the top call down to the deepest running one, joined by ` › `, then `: ` and the deepest call's
  `description` when its input has one. No "Running" prefix.
  - `Bash: Run affected tests`
  - `Agent › Bash: Run affected tests`
  - `Agent › Agent › Bash: Run affected tests`
  - `Agent › Read` (no description)
  - `Agent: Implement the label change` (an agent with no call of its own running)
- Streaming states ("Thinking", "Writing", "Writing a Bash call"), "Waiting on N agents" and "Working" are unchanged.
- A running call's line never turns red for quiet, as now (`activityLine` stops keying that off the "Running " prefix).

**An agent's step** (`doing`, served by `src/state/agents.ts`, shown in the agent list and the agent's row):

- Claude Code sends a Bash step as "Running <description>". Drop the "Running " when the step's `last_tool_name` is
  Bash. Other steps ("Reading src/…") are left as sent.
- An agent finished but with background commands still live: instead of "Waiting on N commands", the descriptions of
  those commands (from `background_tasks_changed`), joined by ", ". Where none has a description, the old text stays.
- The agent log keeps each agent's live command descriptions instead of a count; `AgentEntry.commands` is still the
  count. The log is rebuilt from the events, so its shape can change.

## Left to the builder

Test placement (`test/thread-model.test.ts`, `test/agents.test.ts`) and the exact refactor of `activityLine`.
