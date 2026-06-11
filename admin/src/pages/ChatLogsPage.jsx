import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { timeAgo } from "../utils/formatTime";

export default function ChatLogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      try {
        const data = await api.getChatLogs();
        if (isMounted) setLogs(data);
      } catch (err) {
        if (isMounted) setError(err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <div>
      <div className="page-header">
        <h2>💬 Chat Monitor</h2>
        <p>Real-time activity from all driver groups · Auto-refreshes every 10s</p>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading messages…</div>
      ) : error ? (
        <div className="alert alert-error">⚠️ {error}</div>
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <div className="icon">💬</div>
          <h3>No messages yet</h3>
          <p>Messages from driver groups will appear here in real-time.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Group</th>
                <th>Driver</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-muted)' }}>{timeAgo(log.created_at)}</td>
                  <td><strong>{log.group_name}</strong></td>
                  <td>{log.sender_name || "—"}</td>
                  <td style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis' }}>{log.message_text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────── Broadcast Page ───────────────
