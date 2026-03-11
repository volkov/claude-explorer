const http = require('http');
const fs = require('fs');
const path = require('path');
const { listProjects, listSessions, parseTranscript, isSessionActive } = require('./parser');

const PORT = process.env.PORT || 3939;

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHTML(res, filePath) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // API routes
  if (pathname === '/api/projects') {
    try {
      const projects = await listProjects();
      sendJSON(res, projects);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  const sessionsMatch = pathname.match(/^\/api\/sessions\/(.+)$/);
  if (sessionsMatch) {
    try {
      const sessions = await listSessions(sessionsMatch[1]);
      sendJSON(res, sessions);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)\/([^/]+)$/);
  if (statusMatch) {
    try {
      const active = await isSessionActive(statusMatch[1], statusMatch[2]);
      sendJSON(res, { isActive: active });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  const subagentMatch = pathname.match(/^\/api\/transcript\/([^/]+)\/([^/]+)\/subagent\/(.+)$/);
  if (subagentMatch) {
    try {
      const transcript = await parseTranscript(subagentMatch[1], subagentMatch[2], subagentMatch[3]);
      if (!transcript) { sendJSON(res, { error: 'Not found' }, 404); return; }
      sendJSON(res, transcript);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  const transcriptMatch = pathname.match(/^\/api\/transcript\/([^/]+)\/([^/]+)$/);
  if (transcriptMatch) {
    try {
      const transcript = await parseTranscript(transcriptMatch[1], transcriptMatch[2]);
      if (!transcript) { sendJSON(res, { error: 'Not found' }, 404); return; }
      sendJSON(res, transcript);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  // Serve static files or fallback to index.html
  sendHTML(res, path.join(__dirname, 'public', 'index.html'));
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Claude Transcript Viewer running at http://localhost:${PORT}`);
});
