# 𝐃𝐮𝐧𝐠𝐞𝐨𝐧 𝐁𝐥𝐢𝐭𝐳: 𝐑

Open-source fan revival project of Dungeon Blitz developed by The Minesa Studios.

## About

Dungeon Blitz: R aims to preserve and modernize the Dungeon Blitz experience while improving stability, maintainability, and multiplayer functionality.

The project focuses on:

* Multiplayer support
* Bug fixes and stability improvements
* Localization
* Gameplay balancing
* Quality-of-life improvements
* Community-driven development

## Project Status

Active Development

Current priorities:

* Multiplayer implementation
* Region completion
* Gameplay balancing
* Performance improvements

## Playing single player

Everything runs on your own machine — the server, the game files and your saves. No
account on anyone else's server, no internet connection needed once it is set up.

**You need two things first:**

1. **[Node.js](https://nodejs.org/) (LTS)** — the game server runs on it.
2. **A Flash-capable browser.** Dungeon Blitz is a Flash game and modern browsers dropped
   Flash in 2020. The launchers expect
   [FlashBrowser](https://github.com/radubirsan/FlashBrowser/releases/tag/v0.8); any
   standalone Flash player pointed at `http://localhost:8000/` also works.

**Then just run the launcher for your system:**

| System | File |
| --- | --- |
| macOS | `dev-mac.command` (double-click, or `./dev-mac.command` in Terminal) |
| Windows | `dev-windows.bat` (double-click) |

The launcher pulls the latest code, stashing your local saves first, installs
dependencies, starts the server, and opens the game at `http://localhost:8000/` once it
is listening. Leave the terminal window open while you play — closing it stops the server.

Prefer to drive it yourself?

```bash
npm install
npm run dev
```

Then point your Flash browser at `http://localhost:8000/`.

**Making a character.** Register any email and password on the login screen — it is your
local server, so the account is created on the spot and stored in
`src/server/data/Accounts.json`. Your characters live in `src/server/data/saves/`, which
git ignores, so updating the project never overwrites your progress.

If you would rather skip straight to the content, the seeder below gives you a
fully-completed character in every class.

**If it does not start:**

| Symptom | Cause |
| --- | --- |
| `ERROR: Node.js is not installed or not on PATH` | Install Node.js LTS and re-run the launcher. |
| Browser opens but the page is blank | Flash is not enabled in that browser. Use FlashBrowser or a standalone Flash player. |
| Port 8000 already in use | Another copy of the server is still running. Close its terminal window. |
| The launcher stashed your changes and you want them back | `git stash list`, then `git stash pop` — the launcher labels its stashes with a timestamp. |

The same walkthrough, starting from the clone, is on the
[How to play](https://github.com/theminesastudios/dungeon-blitz-r/wiki/How-to-play-Dungeon-Blitz%3F)
wiki page.

## Playtest account

For local testing there is a seeder that creates `test@theminesa.studio` with six
characters — one fully-completed and one brand new for each of the three classes:

```bash
cd src/server && npm run seed:test-account
```

| Character | Class | State |
| --- | --- | --- |
| `MaxMage` / `MaxPaladin` / `MaxRogue` | Mage / Paladin / Rogue | Level 50, all 293 missions claimed, all 39 class abilities at rank 10, maxed talents and buildings, every mount, pet, charm, dye and material |
| `NewMage` / `NewPaladin` / `NewRogue` | Mage / Paladin / Rogue | Level 1, zero of everything |

The password defaults to `testtest`; override it with `TEST_ACCOUNT_PASSWORD`. Re-running
the seeder is safe — it reuses the account and rewrites the six characters.

The seeder **refuses to run when `MULTIPLAYER_MODE` is set**. It writes a known password
and a character holding every unlock in the game, which is local-play-only by nature.

It writes to `src/server/data/Accounts.json`, which is tracked by git. Leave that change
out of your commits: the matching save file lives in the untracked `saves/` directory, so
a committed account row would be an empty account plus a published password hash.

## Documentation

Project documentation can be found in the Wiki.

## Disclaimer

Dungeon Blitz: R is a fan-made revival project.

Dungeon Blitz and all original assets, trademarks, artwork, audio, characters, and intellectual property belong to their respective owners.

This repository only licenses original code and modifications created by The Minesa Studios and project contributors.
