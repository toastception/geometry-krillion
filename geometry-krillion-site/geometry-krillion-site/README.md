# Geometry Krillion

Krillion-style Geometry Dash trivia, solo or in multiplayer rooms. Plain Node, no dependencies.

## Run

    node server.js        # http://localhost:3000   (set PORT to change)

## How multiplayer works

- Anyone can create a room (4-letter code) and share the invite link `/?room=CODE`.
- The host starts the dive. Everyone gets the same 7 prompts, 25 seconds each.
- Every player answers on their own. A prompt ends when everyone has a valid answer or time runs out.
- After each prompt everyone sees each player's rarity tier and points, never the answers.
- Answer banks stay in `game.js` on the server. Browsers only send guesses and get back a tier.
- Invalid answers can be retried. After 5 misses a player may give up the prompt (0 points).
- Solo is a one-player room with no timer.

## Deploy

Any host that runs Node works (Render, Railway, Fly.io, a VPS). Start command: `node server.js`.
Keep it to ONE instance: rooms live in memory and players are connected to it over Server-Sent Events.
To scale past one instance, move `rooms` to Redis and use pub/sub for broadcasts.
If you use nginx, turn off proxy buffering for `/events`.

## Files

- `server.js`: HTTP API (`POST /api`), live updates (`GET /events`), room and round logic.
- `game.js`: every prompt, answer bank and tier rule (generated from the solo game).
- `public/index.html`: the whole client.

## Adding prompts

Edit the `P` list in `game.js`. Each entry is `[prompt, "Answer|alias;Answer 2", tierCuts?, group?]`.
Answers are ordered most obvious first, which sets their rarity tier.
A leading `*` marks a Too Clever answer.
