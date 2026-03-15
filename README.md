# Heirstone Consulting & Strategic Advisory

Static website for Heirstone Consulting.

## Deployment to Railway

1. Push this repository to GitHub
2. Log in to Railway (railway.app) and create a new project
3. Select "Deploy from GitHub repo"
4. Choose this repository
5. Railway will auto-detect and deploy using `npm start`
6. In Railway settings, add your custom domain from GoDaddy

## Connecting GoDaddy Domain

1. In Railway: Go to your project → Settings → Networking → Add Custom Domain
2. Copy the CNAME record Railway provides
3. In GoDaddy DNS settings, add a CNAME record pointing your domain to Railway's URL
4. Wait up to 24 hours for DNS propagation

## Local Development

```bash
npm install
npm run serve
```
