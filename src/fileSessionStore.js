const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSIONS_DIR || './data/sessions';

function sessionPath(ownId) {
  return path.join(SESSIONS_DIR, `${ownId}.json`);
}

function saveAccountSession(ownId, session) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(sessionPath(ownId), JSON.stringify(session, null, 2));
}

function loadAccountSession(ownId) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(ownId), 'utf8'));
  } catch {
    return null;
  }
}

function loadAccountSessions() {
  const out = {};
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        out[f.replace(/\.json$/, '')] = JSON.parse(
          fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')
        );
      } catch {
        /* skip corrupt file */
      }
    }
  } catch {
    /* dir chưa tồn tại */
  }
  return out;
}

function deleteAccountSession(ownId) {
  try {
    fs.unlinkSync(sessionPath(ownId));
  } catch {
    /* file không tồn tại */
  }
}

module.exports = { saveAccountSession, loadAccountSession, loadAccountSessions, deleteAccountSession };
