# Fictional PR #248 author description

The exact author Markdown below belongs to the fictional `acme/export-service` fixture. Its test-file link is relative to that fictional repository.

```markdown
### What changed

Move large CSV exports off the request path and process them as background jobs.

- Check workspace permissions before accepting an export.
- Keep request and queue identity stable across retries.
- Stream CSV output and complete or abort multipart uploads.

### Review focus

Please review workspace isolation and interrupted uploads.

[See the worker regression tests.](src/workers/worker.test.ts)
```
