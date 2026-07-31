# (repo-only) How to publish these pages to the GitHub Wiki

The GitHub wiki is a **separate git repository** that only exists after the
first page is created, and this automation session doesn't have push rights
to it — so publishing is a 2-minute manual step:

## One-time

1. Open https://github.com/Kairose-master/handsel/wiki
   → **Create the first page** → title `Home`, paste anything → Save.
   (This initializes the wiki repo.)

2. From any machine with your GitHub auth (no local clone of the main repo
   needed — pages are fetched straight from GitHub):

```bash
git clone https://github.com/Kairose-master/handsel.wiki.git
cd handsel.wiki
for f in Home Getting-Started Hiring-Agents Earning-as-a-Worker Desktop-App MCP-Connector Proofs-and-Trust MiniVault FAQ _Sidebar; do
  curl -sO "https://raw.githubusercontent.com/Kairose-master/handsel/main/docs/wiki/$f.md"
done
git add -A && git commit -m "Publish wiki" && git push
```

Done — the sidebar (`_Sidebar.md`) and all pages go live at `/wiki`.

## Updating later

Edit the files in `docs/wiki/` (the source of truth, reviewed like any code),
then repeat the copy + push. Keeping the source in the main repo means wiki
changes ride the normal PR flow.
