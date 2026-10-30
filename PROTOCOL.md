# Urja protocol observations

Base origin: `https://urja-ops.flockenergy.tech`. Observed on 29 October 2026. No secret values are included here.

## Login and session

The public `/login` HTML contains a POST form with `email` and `password`. A URL-encoded POST to `/login`, with same-origin Origin and Referer, returned HTTP 200 and `__Secure-better-auth.session_token`. The cookie had Secure, HttpOnly, SameSite=Lax, Path=/ and an expiry. Login success was established by protected reads, not the 200 status alone. Whether Origin/Referer are strictly required was not tested.

A fresh client sending only that cookie received 200 from search, detail, geo, energy and transformer listing. Those reads did not return Set-Cookie. Search without a cookie returned 401 and `{"error":"unauthorized","message":"A valid session is required."}`. Sending the same value only as Authorization Bearer returned 401. The HTML `/meters` route redirects unauthenticated users to `/login`.

Do not infer a Better Auth login endpoint merely from the cookie name. This implementation uses the observed form flow. Long-term rotation, concurrent-session behavior and multi-session logout scope remain unverified. No session/password is stored by the adapter after returning login results, apart from transient request memory.

## Logout

The portal's Sign out button sent `POST /api/auth/sign-out`. A direct verification with a valid session returned HTTP 200 and `{"success":true}`. The response expired `__Secure-better-auth.session_token` and also cleared the related session-data and remember-choice cookies. Reusing the old main session cookie after this call returned 401 from meter search.

The adapter exposes this as `POST /api/v1/auth/logout`. It forwards the main session cookie, does not retry the state-changing request, and returns success only when Urja returns the expected body and clears the main cookie. The upstream `Set-Cookie` headers are not exposed to the API caller.

## Meter search

Implementation smoke test: a wrong password returned HTTP 200 containing a JSON SvelteKit action result with `type: failure` and `status: 401`. The adapter maps that verified failure to `401 INVALID_CREDENTIALS`; a 200 without a cookie and without that failure signature remains an unsupported-authentication error. Cookie lifetime can use Max-Age rather than Expires; the adapter uses the cookie library's effective expiry calculation.

`GET /portal/meters/search?q=J100007&page=1` returns:

```json
{
  "data": [
    {
      "meterId": "J100007",
      "serialNo": "SE11409",
      "make": "Genus",
      "phaseType": "single",
      "installStatus": "Decommissioned",
      "dtCode": "DT-008"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

Full and partial meter IDs and serial numbers match. An unknown search returns an empty data array. No adjustable page size or additional filters are promised. Preserve manufacturer and serial strings, including ampersands.

## Resource integration

- `/meters/{id}/__data.json?x-sveltekit-invalidated=001`: indexed SvelteKit serialization; legacy parameter arrays and newer JSON in detail.classData both occur.
- `/portal/meters/{id}/geo`: coordinate strings in a data object.
- `/portal/meters/{id}/energy`: timestamp and numeric strings; timezone unknown. Cumulative energy must not be summed as interval consumption.
- `/portal/dts?page=1`: paginated transformer listing.

See INVESTIGATION_LOG.md for the full evidence and known source discrepancies. Signed export automation is implemented as described below.

All four resource integrations above are now implemented. The adapter uses devalue.unflatten for indexed arrays, without executing response content. Relevant data nodes are selected by decoded content rather than node position. Both the outer meterId and inner nameplate identity must match the requested ID; conflicting nameplate or hierarchy identities fail with 502.

A live request to `/meters/J999999/__data.json?x-sveltekit-invalidated=001` returned HTTP 200 with `{"type":"data","nodes":[{"type":"skip"},{"type":"skip"},{"type":"error","error":{"message":"Meter not found"},"status":404}]}`. The adapter recognizes that embedded error and returns 404 METER_NOT_FOUND. A missing data node by itself is not evidence that a meter is absent.

Live smoke checks passed for J100001 (legacy), J100020 (v2 installed), J100004 (faulty), J100007 (decommissioned), J100400 location with the preserved Old Malviya Nagar Xfmr / DT-007 name, J100007 readings filtered inclusively to two timestamps, transformer page 2 (20 records, total 40), and J999999 (404). No secret values are recorded in these documents.

## Signed bulk export

The normal transformers-page JavaScript fetches GET /portal/keys and reads data.signingSecret. It constructs the UTF-8 message from GET, /portal/export, page=1 and String(Math.floor(Date.now()/1000)), joined with newlines and no trailing newline. The key is the UTF-8 signingSecret string. HMAC-SHA256 output is lowercase hexadecimal. GET /portal/export?page=1 carries x-timestamp, x-signature and the session cookie. Our implementation reproduces this normal flow without evaluating portal JavaScript.

The observed response was {data, total}, 403 unique records and total 403. The browser downloads only data as a formatted root array, explaining the downloaded file's different envelope. Rows include meterId, serialNo, make, phaseType, installStatus, installType, build, dtCode, structured hierarchy and numeric geo.lat/lng. The snapshot does not contain energy readings. Key rotation and timestamp tolerance remain unverified.

Bulk normalization exposed additional source quirks: empty hierarchy codes with valid names and empty names with valid codes. Preserve the populated component, represent empty codes as null, and issue warnings. Do not substitute transformer-catalog names for meter aliases. Whole Current is another observed installation type and maps to whole_current. The signed export endpoint passed live verification on 30 October 2026.
