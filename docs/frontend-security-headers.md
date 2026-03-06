# Frontend Security Headers — Deployment Guide

> For the frontend host (Vercel, nginx, or reverse proxy).
> The NestJS API has its own Helmet-based headers (see `src/main.ts`).

## Recommended Headers

| Header | Value | Notes |
|--------|-------|-------|
| `Content-Security-Policy` | See below | Allows API calls to backend origin |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Safe default |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disable unused APIs |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS only (production) |

## CSP for Frontend

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'self' https://api.yourdomain.com;
font-src 'self';
object-src 'none';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
```

**Adjust `connect-src`** to match your API domain. In local dev, this is `http://localhost:3000`.

## Vercel Configuration

Add to `vercel.json` in the frontend repo:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.yourdomain.com; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        }
      ]
    }
  ]
}
```

## Nginx Configuration

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.yourdomain.com; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
```

## Local vs Production

| Aspect | Local (development) | Production |
|--------|-------------------|------------|
| CSP on API (Helmet) | Disabled (for Swagger UI/HMR) | Enabled |
| CSP on Frontend | Not enforced (Vite dev server) | Enforced via Vercel/nginx |
| HSTS | Not needed (HTTP) | Required |
| `X-Frame-Options` | Optional | DENY |
| Swagger `persistAuthorization` | Enabled | Disabled |

## Compatibility Notes

- `'unsafe-inline'` in `style-src` is needed for dynamically injected styles (common in Vite/React apps). If you adopt CSS-in-JS with nonces, switch to `'nonce-<value>'`.
- `blob:` in `img-src` is needed if the app creates object URLs for images.
- `connect-src` must include the actual API domain; otherwise XHR/fetch calls will be blocked.
- `frame-ancestors 'none'` is the CSP equivalent of `X-Frame-Options: DENY`. Both are set for browser compatibility.
