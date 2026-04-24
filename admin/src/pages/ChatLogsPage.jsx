import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as api from "../api";
import { TelegramPreview, MediaUploader, MediaPositionSelector, useFormattingToolbar, getDaysUntilBirthday } from "../components/Shared";

export default function ChatLogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await api.getChatLogs();
      setLogs(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

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

  const formatDate = (date) => new Date(date).toLocaleString();

  return (
    <div>
      <div className="page-header">
        <h2>💬 Live Chat Logs</h2>
        <p>Real-time activity from all driver groups</p>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading logs...</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : (
        <div className="logs-container card">
          <table className="logs-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Group</th>
                <th>Driver</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td className="log-time">{formatDate(log.created_at)}</td>
                  <td><strong>{log.group_name}</strong></td>
                  <td>{log.sender_name || "-"}</td>
                  <td className="log-text">{log.message_text}</td>
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
