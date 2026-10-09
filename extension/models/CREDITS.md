# Model credits (all CC0 — free for commercial use, no attribution required)

- **RobotExpressive.glb** — Tomás Laulhé (Quaternius); facial morphs by Don McCurdy. From the three.js examples.
- **Knight, Mage, Barbarian, Rogue, Rogue_Hooded** — KayKit Character Pack: Adventurers, by Kay Lousberg
  (github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0). Trimmed to the clips Deskmate uses
  (Idle, Walking_A, Sit_Chair_Idle, Sit_Chair_Down, Cheer, Interact, Use_Item) and with hand-held weapons removed.

## Adding your own characters

Drop rigged `.glb` / `.fbx` files in this folder and list them in `manifest.json`:

- `name` / `color` — shown in the setup picker; the colour is used for name tags.
- `clips` maps Deskmate roles (`idle`, `walk`, `sitIdle`, `wave`, `raise`, `typing`) to clip names in the file.
- `once` lists clips that play once and hold their last frame (e.g. a sit-down).
- `bones` maps Mixamo bone names to the model's own names, so typing/wave/raise poses can be added in code.
- `tint` lists material names that take a colour (`[]` = keep the model's own colours).
- `height` is the character's height in desk units (the desk is 0.76 tall).
