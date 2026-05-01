# 𝐃𝐮𝐧𝐠𝐞𝐨𝐧 𝐁𝐥𝐢𝐭𝐳: 𝐑
> Private version of Dungeon Blitz: R, for early access and going to be used for the multiplayer version.

## Installation
_This is required to play singleplayer._

### 1. Requirements
1. Install [Node.js](https://nodejs.org/en/download)
2. [Git](https://git-scm.com/install/)
3. [Flash Projector](https://github.com/Grubsic/Adobe-Flash-Player-Debug-Downloads-Archive/raw/main/Windows/flashplayer_32_sa.exe)
4. [GitHub Desktop](https://desktop.github.com/download/)[^1]
5. Terminal

### 2. Clone Repository
```sh
git clone https://github.com/minesa-org/dungeon-blitz-r.git
cd dungeon-blitz-r
```

### 3. Install Depencies
Install everything with a single command:
```sh
npm run install:all
```

## Running the Game
- Development version:
```sh
npm run dev
```
- Multiplayer version[^2]:
```sh
npm run start:multiplayer
```

## Playing the game
Open the game in Flash Projector using:
```sh
http://localhost/p/cbv/DungeonBlitz.swf?fv=cbq&gv=cbv
```

[^1]: GitHub Desktop is optional to download.
[^2]: You won't run multiplayer version.
