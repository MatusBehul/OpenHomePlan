# Deploying the public page

The page in `site/` is a static site in several languages: `site/src/page.html` is the template,
`site/i18n/<code>.json` holds the text, and `npm run site` renders them into `site/dist/` (English at
`/`, other languages at `/<code>/`). The same build puts an online demo of the app in `/demo/`:
`public/` plus the templates from `examples/` and the Three.js files, as static files. It can't
save anything (there is no server behind it), says so in a banner, and gets its own
Content-Security-Policy (`site/dist-nginx/demo-headers.conf`, with hashes of the import maps). The
Docker build runs the same step. It runs on Cloud Run (project `openhomeplan`, region
`europe-west1`, service `openhomeplan-site`) behind `https://openhomeplan.wadby.tech`, and is
deployed by `.github/workflows/site.yml` whenever `site/` or `deploy/site/` changes on `main`.
The planner itself is never hosted: it runs on each user's own computer.

The workflow logs in without stored keys (Workload Identity Federation): only pushes to `main`
of `MatusBehul/OpenHomePlan` can deploy.

## One-time setup (Google Cloud)

```sh
gcloud config set project openhomeplan
PROJECT_NUMBER=$(gcloud projects describe openhomeplan --format='value(projectNumber)')

gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com

# image registry
gcloud artifacts repositories create site --repository-format=docker --location=europe-west1

# the service runs as an account with no permissions at all
gcloud iam service-accounts create site-runtime --display-name="Public page (runtime)"

# the deploy account used by GitHub Actions
gcloud iam service-accounts create site-deployer --display-name="Public page (deploy from GitHub)"
DEPLOYER=site-deployer@openhomeplan.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding openhomeplan --member="serviceAccount:$DEPLOYER" --role=roles/run.admin
gcloud projects add-iam-policy-binding openhomeplan --member="serviceAccount:$DEPLOYER" --role=roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding site-runtime@openhomeplan.iam.gserviceaccount.com \
  --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser

# GitHub → Google login, restricted to this repository's main branch
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers create-oidc openhomeplan-repo --location=global \
  --workload-identity-pool=github --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='MatusBehul/OpenHomePlan' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/MatusBehul/OpenHomePlan"

echo "GCP_WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/openhomeplan-repo"
echo "GCP_DEPLOY_SA=$DEPLOYER"
```

In GitHub: **Settings → Secrets and variables → Actions → Variables**, add `GCP_WIF_PROVIDER` and
`GCP_DEPLOY_SA` with the two values printed above (they are not secret). Then run the
**Public page** workflow once (Actions tab → Run workflow).

## Domain

1. Verify `wadby.tech` for your Google account once: `gcloud domains verify wadby.tech`
   (opens Search Console; add the TXT record it shows).
2. Map the subdomain to the service:
   ```sh
   gcloud beta run domain-mappings create --service openhomeplan-site \
     --domain openhomeplan.wadby.tech --region europe-west1
   ```
3. At the DNS provider of `wadby.tech`, add `CNAME openhomeplan → ghs.googlehosted.com.`
   The HTTPS certificate is issued automatically (can take up to an hour).

Cloud Run domain mappings are a preview feature. If they are ever unavailable, the alternative is
a global HTTPS load balancer with a serverless network endpoint group (costs about $18/month), or
Firebase Hosting in front of the same service.

## Cost

With `--min-instances 0` the service sleeps when nobody visits; a small static page stays inside
Cloud Run's free tier. The only other costs are a few MB in Artifact Registry.

## Test locally

```sh
npm run site                                     # then open site/dist/index.html
# or the real container:
docker build -f deploy/site/Dockerfile -t openhomeplan-site .
docker run --rm -p 8080:8080 openhomeplan-site   # http://localhost:8080
```

## Google Drive folders in the online demo

The demo can open a Google Drive folder shared as "Anyone with the link can view" and show the
houses in it, read-only (`public/drive.js`). It uses the Drive API with a browser API key kept in
`site/config.json`. The key is meant to be public (it is in the page): it is restricted to the Drive
API and to the site's addresses as referrer, so it can't be used from elsewhere. The demo sends its
origin as referrer to Google (`Referrer-Policy: strict-origin` in the demo headers) and allows only
`https://www.googleapis.com` beyond its own files.

```sh
gcloud services enable drive.googleapis.com apikeys.googleapis.com --project openhomeplan
gcloud services api-keys create --project openhomeplan \
  --display-name="OpenHomePlan demo: read shared Drive folders" \
  --api-target=service=drive.googleapis.com \
  --allowed-referrers="https://openhomeplan.wadby.tech/*,https://openhomeplan-site-4roa4bj3lq-ew.a.run.app/*,http://localhost:3301/*"
gcloud services api-keys get-key-string <uid> --project openhomeplan   # → site/config.json
```

Without `site/config.json` the build leaves the feature out.

### Comments from the demo (Google sign-in)

Comments written on a house from a shared folder are saved to the commenter's own Google Drive.
The demo signs in with a plain OAuth redirect (no Google script on the page): `oauth.html` receives
the token. Setup in the Google Cloud console (Google Auth Platform) of the project: branding (app
name, support email, authorized domain `wadby.tech`), audience External (in Testing: add the
commenters as test users), data access scope `https://www.googleapis.com/auth/drive.file`
(non-sensitive), and an OAuth client of type Web application with these redirect URIs:

- `https://openhomeplan.wadby.tech/demo/oauth.html`
- `https://openhomeplan-site-4roa4bj3lq-ew.a.run.app/demo/oauth.html`
- `http://localhost:3301/demo/oauth.html`

Its client id goes into `site/config.json` as `googleClientId` (it is public; no secret is used).
