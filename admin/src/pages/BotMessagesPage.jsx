import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api";

const PAGE_SIZE = 50;

function formatSentAt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function chatLabel(row) {
  if (row.chat_title) return row.chat_title;
  return `chat ${row.telegram_chat_id}`;
}

function preview(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "(media message without text)";
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

export default function BotMessagesPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);

  // Filters (applied on submit / debounce-free — small dataset per admin action).
  const [searchInput, setSearchInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [search, setSearch] = useState("");
  const [chatId, setChatId] = useState("");

  // Inline edit / delete state.
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const fetchRows = useCallback(async (nextOffset = 0) => {
    setLoading(true);
    setMessage(null);
    try {
      const data = await api.getBotMessages({
        search: search || undefined,
        chatId: chatId || undefined,
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      setRows(Array.isArray(data?.messages) ? data.messages : []);
      setTotal(Number(data?.total) || 0);
      setOffset(nextOffset);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, [search, chatId]);

  useEffect(() => {
    fetchRows(0);
  }, [fetchRows]);

  const applyFilters = (e) => {
    e?.preventDefault?.();
    setSearch(searchInput.trim());
    setChatId(chatInput.trim());
  };

  const startEdit = (row) => {
    setConfirmDeleteId(null);
    setEditingId(row.id);
    setEditText(row.message_text || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const saveEdit = async (row) => {
    if (!editText.trim()) {
      setMessage({ type: "error", text: "Replacement text cannot be empty." });
      return;
    }
    setBusyId(row.id);
    setMessage(null);
    try {
      const res = await api.editBotMessage(row.id, editText);
      const updated = res?.message;
      setRows((prev) => prev.map((r) => (r.id === row.id && updated ? updated : r)));
      setMessage({
        type: "success",
        text: res?.reason === "not_modified"
          ? "No change — the text was already up to date."
          : `Message edited in ${chatLabel(row)}.`,
      });
      cancelEdit();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async (row) => {
    setBusyId(row.id);
    setMessage(null);
    try {
      const res = await api.deleteBotMessage(row.id);
      const updated = res?.message;
      setRows((prev) => prev.map((r) => (r.id === row.id && updated ? updated : r)));
      setMessage({
        type: "success",
        text: res?.reason === "already_gone"
          ? "Message was already gone in Telegram — marked deleted."
          : `Message deleted from ${chatLabel(row)}.`,
      });
      setConfirmDeleteId(null);
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <div className="page-header">
        <h2>📨 Bot Messages</h2>
        <p>
          Every message the bot has sent. Edit or delete any of them directly — even in groups
          that don't expose message links.
        </p>
      </div>

      {message && (
        <div className={`alert alert-${message.type}`}>
          {message.type === "success" ? "✅" : "⚠️"} {message.text}
        </div>
      )}

      <form
        onSubmit={applyFilters}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center" }}
      >
        <input
          type="text"
          placeholder="Search message text…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <input
          type="text"
          placeholder="Filter by chat id (e.g. -1001234…)"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          style={{ maxWidth: 240 }}
        />
        <button type="submit" className="btn btn-secondary">Apply</button>
        {(search || chatId) && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setSearchInput("");
              setChatInput("");
              setSearch("");
              setChatId("");
            }}
          >
            Clear
          </button>
        )}
        <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-muted)" }}>
          {total > 0 ? `${pageStart}–${pageEnd} of ${total}` : "no messages"}
        </span>
      </form>

      {loading ? (
        <div className="loading"><div className="spinner"></div> Loading messages…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📨</div>
          <h3>No bot messages found</h3>
          <p>Messages the bot sends will show up here so you can edit or delete them.</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Sent</th>
                <th>Chat</th>
                <th>Source</th>
                <th>Text</th>
                <th style={{ minWidth: 160 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditing = editingId === row.id;
                const isDeleted = Boolean(row.deleted_at);
                const isBusy = busyId === row.id;
                return (
                  <tr key={row.id} style={isDeleted ? { opacity: 0.55 } : undefined}>
                    <td style={{ whiteSpace: "nowrap", fontSize: 12 }}>{formatSentAt(row.sent_at)}</td>
                    <td style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 600 }}>{chatLabel(row)}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{row.telegram_chat_id}</div>
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{row.source_method || "—"}</td>
                    <td style={{ maxWidth: 420 }}>
                      {isEditing ? (
                        <textarea
                          className="form-textarea"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          style={{ minHeight: 80, width: "100%" }}
                          autoFocus
                        />
                      ) : (
                        <div>
                          <div style={{ whiteSpace: "pre-wrap" }}>{preview(row.message_text)}</div>
                          <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {isDeleted && (
                              <span className="badge" style={{ background: "#7f1d1d", color: "#fff", fontSize: 11 }}>
                                🗑️ deleted
                              </span>
                            )}
                            {!isDeleted && row.edited_at && (
                              <span className="badge" style={{ background: "#1e3a8a", color: "#fff", fontSize: 11 }}>
                                ✏️ edited
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn btn-primary" disabled={isBusy} onClick={() => saveEdit(row)}>
                            {isBusy ? "Saving…" : "Save"}
                          </button>
                          <button className="btn btn-ghost" disabled={isBusy} onClick={cancelEdit}>Cancel</button>
                        </div>
                      ) : confirmDeleteId === row.id ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn btn-danger" disabled={isBusy} onClick={() => confirmDelete(row)}>
                            {isBusy ? "Deleting…" : "Confirm"}
                          </button>
                          <button className="btn btn-ghost" disabled={isBusy} onClick={() => setConfirmDeleteId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            className="btn btn-secondary"
                            disabled={isDeleted || isBusy}
                            title={isDeleted ? "Deleted messages can't be edited" : "Edit this message"}
                            onClick={() => startEdit(row)}
                          >
                            ✏️ Edit
                          </button>
                          <button
                            className="btn btn-danger"
                            disabled={isDeleted || isBusy}
                            title={isDeleted ? "Already deleted" : "Delete this message"}
                            onClick={() => { setEditingId(null); setConfirmDeleteId(row.id); }}
                          >
                            🗑️
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 16 }}>
          <button
            className="btn btn-secondary"
            disabled={offset === 0 || loading}
            onClick={() => fetchRows(Math.max(0, offset - PAGE_SIZE))}
          >
            ← Previous
          </button>
          <button
            className="btn btn-secondary"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => fetchRows(offset + PAGE_SIZE)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
