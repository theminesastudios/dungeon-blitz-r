# Dungeon Blitz R - Codex Skill Guide

## Project Context

This project is Dungeon Blitz R, a restoration/rebuild/debug-focused game project based on the original Dungeon Blitz experience.

The main goal is to preserve the original gameplay feel while fixing crashes, display issues, dungeon sequencing bugs, fullscreen problems, UI scaling problems, boss spawn problems, combat state issues, and multiplayer-related systems.

When working on this project, prioritize stability, original behavior, and regression safety.

## Core Rules

- Do not rewrite large systems unless absolutely necessary.
- Prefer small, targeted, reversible fixes.
- Preserve original gameplay behavior whenever possible.
- Avoid temporary hacks that skip frames, suppress errors silently, or hide broken state.
- Never “fix” a crash by ignoring the underlying broken state.
- Do not remove existing working logic unless there is clear evidence it is wrong.
- Always check whether a change can affect fullscreen, 2K/4K scaling, cutscenes, boss spawns, combat state, or dungeon sequencing.

## Debugging Priorities

When investigating a bug, follow this order:

1. Reproduce the issue.
2. Identify the exact state transition where it breaks.
3. Compare fullscreen and windowed behavior.
4. Check entity lifecycle:
   - spawn
   - visibility
   - room assignment
   - team assignment
   - HP/death state
   - combat registration
   - display object attachment
5. Check cutscene start/end logic.
6. Check packet order and entity references.
7. Verify that the fix does not break other dungeons.

## Fullscreen / Resolution Rules

Fullscreen, 2K, and 4K fixes must not change gameplay logic.

When fixing display scaling:

- Keep the game world coordinate logic separate from UI scaling.
- Do not scale combat entities incorrectly.
- Do not allow fullscreen mode to detach or hide active enemies.
- Bosses and enemies must remain visible after cutscenes.
- UI scaling must not affect entity HP, death state, hitbox, combat targetability, or room ownership.
- Avoid global scale changes that affect cloaks, characters, pets, projectiles, or enemy sprites unexpectedly.

## Boss / Dungeon Rules

Boss entities must never be marked dead, hidden, detached, or removed just because a cutscene ends.

For boss encounters:

- Boss spawn must happen in the correct dungeon phase.
- Bosses must remain alive after the cutscene unless explicitly killed by combat.
- Bosses must stay visible and targetable.
- Bosses must be registered in combat state.
- Bosses must keep correct team and room data.
- Bosses must not continue damaging the player while visually hidden or marked as dead.
- If a boss can deal damage, it must also be visible and valid in combat state.

Special attention:

- Seelie Ravager
- Mortis Golem
- Jade City / Back Alley Deals
- JC_Mission2 boss sequence

## Cutscene Rules

Cutscene logic must not corrupt combat or entity state.

When a cutscene ends:

- Restore player control only after all required entities are valid.
- Do not accidentally call enemy cleanup logic.
- Do not reset boss HP to zero.
- Do not mark spawned bosses as defeated.
- Do not remove boss display objects.
- Do not skip required dungeon phase triggers.
- Verify post-cutscene boss state before allowing combat to continue.

## Combat State Rules

CombatState errors must be fixed at the source.

Do not solve stack depth, display, or combat crashes by simply adding broad try/catch blocks.

When touching CombatState:

- Keep stack balance safe.
- Avoid recursive calls without clear exit conditions.
- Validate source and target entities before attacks.
- Validate entity alive/dead state before applying damage.
- Ensure hidden/dead entities cannot keep attacking.
- Ensure active enemies are visible and properly registered.

## Packet / Entity Debugging

When packet logs are provided, use them to identify entity lifecycle issues.

Important fields:

- packet opcode
- user
- token
- character
- level
- entity id
- payload
- refs
- entity name
- team
- room

If an entity appears in packet refs but is invisible or dead in-game, investigate display attachment, death state, room state, and post-cutscene cleanup.

## Trap / Chest / Dungeon Trigger Rules

If a dungeon originally has trap logic, chest-break triggers, or delayed enemy spawns, preserve and restore that behavior.

When fixing missing dungeon steps:

- Check whether chest destruction should trigger enemy spawn.
- Check whether the trap sequence is disabled or skipped.
- Check whether the dungeon phase advances too early.
- Check whether enemies are spawned but hidden, dead, or assigned to the wrong room.
- Do not bypass trap logic just to make the dungeon completable.

## Regression Safety

Before finalizing any fix, verify:

- Windowed mode still works.
- Fullscreen mode works.
- 1080p works.
- 2K and 4K behavior does not break.
- Boss cutscenes complete without crash.
- Bosses remain visible after cutscene.
- Bosses do not become dead immediately after spawning.
- Bosses cannot attack while invisible/dead.
- Other dungeons are not affected.
- Existing working systems are not rewritten unnecessarily.

## Preferred Fix Style

Use clear, minimal patches.

A good fix should:

- Target the exact broken transition.
- Add validation where state becomes invalid.
- Keep original game behavior.
- Include comments only where the logic is non-obvious.
- Avoid broad rewrites.
- Avoid masking the problem.

A bad fix:

- Adds random delays.
- Skips frames to avoid crashes.
- Silently catches errors without correcting state.
- Removes boss cleanup entirely without understanding why it exists.
- Globally changes scaling for all objects.
- Forces HP/state values without fixing the lifecycle bug.

## Commit / PR Notes

When preparing a commit or PR, include:

- What was broken.
- Why it happened.
- What was changed.
- What was tested.
- Whether fullscreen/windowed mode was checked.
- Whether boss cutscene behavior was checked.

Example format:

```md
## Summary

Fixed an issue where boss entities could disappear or be marked dead after a cutscene in fullscreen mode.

## Cause

The cutscene end/display refresh path was incorrectly affecting active boss entity display/state.

## Changes

- Preserved boss entity state after cutscene completion.
- Added validation for visible/alive combat entities after cutscene end.
- Prevented hidden/dead boss entities from remaining active attackers.

## Tested

- Windowed mode
- Fullscreen mode
- JC_Mission2
- Seelie Ravager
- Mortis Golem
- Boss cutscene completion
