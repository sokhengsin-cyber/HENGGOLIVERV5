# HENGGOLIVER Roblox Eligibility Checker + Robux Tracker

This version keeps the original black/green HENGGOLIVER UI and adds:

- Roblox group membership-age eligibility checker (Open Cloud)
- Roblox avatar/headshot display
- Sending-account management
- Robux send recording
- Receiver username + user ID + avatar history
- Total sent, last-24-hour and last-30-day totals
- Configurable per-alt 24-hour and 30-day limits
- Estimated next rolling limit release time
- Searchable send history
- Optional staff/admin token for write actions
- Light/dark mode

## Setup

1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `ROBLOX_API_KEY`.
4. Set `ADMIN_TOKEN` to a long secret if the site is publicly reachable.
5. Run `npm start`.

## Railway

The app works on Railway. For persistent Robux history, mount a Railway Volume and set `DATA_FILE` to a path inside that volume, for example:

`DATA_FILE=/data/tracker.json`

Without persistent storage, Railway redeploys can erase the local JSON tracker file.

## Important tracker note

The Robux tracker calculates limits from sends recorded in this app. It does not read Roblox's private remaining transfer quota. If you send Robux outside this system, add that send here too so the totals stay accurate.

The default 5,000 / 10,000 values are editable per sending account. The UI uses rolling 24-hour and rolling 30-day windows as a conservative tracking model.
