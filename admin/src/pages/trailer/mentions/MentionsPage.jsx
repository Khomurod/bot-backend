import React, { useState } from "react";
import api from "../../../api/trailerAgreements";
import dept from "../../../api/trailerDepartment";
import { Alert, Empty, PageHeader, Table, useLoad } from "../TrailerUi";
import MentionResolveDialog from "./MentionResolveDialog";

const ACTIONS = [
  { key: "linked", label: "Link" },
  { key: "created", label: "Create manually" },
  { key: "ignored", label: "Ignore" },
  { key: "false_detection", label: "False detection" },
];

function suggested(row) {
  const ids = Array.isArray(row.suggested_trailer_ids) ? row.suggested_trailer_ids : [];
  return ids.length ? ids.join(", ") : "—";
}

export default function MentionsPage() {
  const list = useLoad(() => api.listMentions({ review_status: "pending" }), []);
  const assets = useLoad(() => dept.trailers(), []);
  const [resolve, setResolve] = useState(null); // { mention, action }
  const [msg, setMsg] = useState(null);

  const trailers = assets.data?.trailers || [];

  const submit = async (body) => {
    await api.resolveMention(resolve.mention.id, body);
    setResolve(null);
    setMsg({ text: "Mention resolved." });
    list.reload();
  };

  const columns = [
    {
      key: "normalized_unit_number",
      label: "Detected",
      render: (r) => r.normalized_unit_number || r.raw_unit_number || "—",
    },
    { key: "telegram_group_title", label: "Group", render: (r) => r.telegram_group_title || "—" },
    {
      key: "sender_name",
      label: "Sender",
      render: (r) => r.sender_name || r.sender_username || "—",
    },
    {
      key: "detected_at",
      label: "Detected",
      render: (r) => (r.detected_at ? new Date(r.detected_at).toLocaleString() : "—"),
    },
    {
      key: "ai_confidence",
      label: "Confidence",
      render: (r) => (r.ai_confidence != null ? `${r.ai_confidence}%` : "—"),
    },
    { key: "suggested_trailer_ids", label: "Suggested", render: suggested },
    { key: "extracted_action", label: "Action", render: (r) => r.extracted_action || "—" },
    { key: "extracted_location", label: "Location", render: (r) => r.extracted_location || "—" },
    {
      key: "actions",
      label: "",
      render: (r) => (
        <div className="trailer-actions">
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={(e) => {
                e.stopPropagation();
                setResolve({ mention: r, action: a.key });
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Unmatched Mentions"
        subtitle="Telegram trailer mentions that matched no master-list unit — link, ignore, or dismiss them."
      />
      <Alert message={msg} />
      {list.error && <div className="alert alert-danger">{list.error}</div>}
      {list.loading ? (
        <div className="loading">Loading…</div>
      ) : !list.data?.rows?.length ? (
        <Empty>No pending mentions to review.</Empty>
      ) : (
        <Table rows={list.data.rows} columns={columns} />
      )}
      {resolve && (
        <MentionResolveDialog
          mention={resolve.mention}
          action={resolve.action}
          trailers={trailers}
          onClose={() => setResolve(null)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
