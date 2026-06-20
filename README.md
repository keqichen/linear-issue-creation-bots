# linear-issue-creation-bots

Converts chat messages from Discord and Notion into Linear issues using Claude AI.

## How it works

- **Discord**: React to any message with 📌, or prefix a message with `!task ...`
- **Notion**: Include `#task` in a comment on any page

Claude classifies the message, infers a title, context, acceptance criteria, priority, and assignee, then creates the issue in Linear and replies with a link.

## Team routing

| Person | Owns |
|--------|------|
| Lee | Engine, UE5, physics, performance, build/CI, UE5 widget/UI implementation, screen ratios |
| Keqi | Gameplay, UI design/UX, level design, assets, art |

Unrecognised or ambiguous tasks default to Lee.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file

```env
DISCORD_TOKEN=
ANTHROPIC_API_KEY=
LINEAR_API_KEY=
LINEAR_TEAM_ID=
NOTION_TOKEN=
NOTION_SIGNING_SECRET=
```

### 3. Discord setup

1. Create a bot at discord.com/developers → enable **Message Content Intent** and **Server Members Intent**
2. Invite the bot to your server with `bot` + `applications.commands` scopes

### 4. Notion setup

1. Create an integration at notion.so/profile/integrations
   - Capabilities: Read content, Read comments, Insert comments
2. Share your root Notion page with the integration (child pages inherit)
3. Add a webhook pointing to `https://<your-server>/notion-webhook` with event `comment.created`
4. Copy the signing secret → `NOTION_SIGNING_SECRET` in `.env`

### 5. Run locally

```bash
node index.js
```

For Notion webhooks locally, expose port 3000 with ngrok:

```bash
npx ngrok http 3000
```

Then update the Notion webhook URL to the ngrok `https` URL.

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Add all `.env` variables in the Railway dashboard under **Variables**
4. Railway will run `npm start` automatically
5. Once deployed, update the Notion webhook URL to your Railway public URL
