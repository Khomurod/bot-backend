import React, { useState } from "react";
import api from "../../../api/trailerAgreements";
import dept from "../../../api/trailerDepartment";
import { Alert, Card, Empty, PageHeader, Status, Table, useLoad } from "../TrailerUi";
import ReconciliationPanel from "./ReconciliationPanel";

const COLUMNS = [
  { key: "file_name", label: "Batch", render: (r) => r.file_name || `Import #${r.id}` },
  { key: "status", label: "Status", render: (r) => <Status value={r.status} /> },
  { key: "image_count", label: "Images" },
  { key: "parsed_count", label: "Parsed" },
  { key: "conflict_count", label: "Conflicts" },
  {
    key: "confirmed_at",
    label: "Confirmed",
    render: (r) => (r.confirmed_at ? new Date(r.confirmed_at).toLocaleString() : "—"),
  },
  {
    key: "created_at",
    label: "Created",
    render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "—"),
  },
];

function UploadCard({ onUploaded, setMsg }) {
  const [files, setFiles] = useState([]);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    if (!files.length || !confirmComplete || busy) return;
    setBusy(true);
    try {
      const result = await api.uploadImport(files);
      setFiles([]);
      setConfirmComplete(false);
      setMsg({ text: "Import staged. Review and reconcile below." });
      onUploaded(result);
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h3>Upload the official trailer list</h3>
      <input
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => setFiles(Array.from(e.target.files || []))}
      />
      <label className="trailer-check" style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={confirmComplete}
          onChange={(e) => setConfirmComplete(e.target.checked)}
        />
        This represents the complete official trailer list
      </label>
      <p className="trailer-help">
        Staging only — nothing reaches the master list until you confirm the batch
        and apply reconciliation.
      </p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!files.length || !confirmComplete || busy}
        onClick={upload}
      >
        {busy ? "Uploading…" : `Upload ${files.length || 0} image(s)`}
      </button>
    </Card>
  );
}

export default function MasterImportPage() {
  const list = useLoad(() => api.listImports(), []);
  const [selectedId, setSelectedId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const recon = useLoad(
    () => (selectedId ? api.importReconciliation(selectedId) : Promise.resolve(null)),
    [selectedId],
  );
  // The searchable merge picker needs the current official trailer list.
  const assets = useLoad(() => dept.trailers(), []);

  const confirm = async () => {
    setBusy(true);
    try {
      await api.confirmImport(selectedId);
      setMsg({ text: "Batch confirmed as the complete list." });
      await recon.reload();
      list.reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const apply = async (decisions) => {
    setBusy(true);
    try {
      const result = await api.reconcileImport(selectedId, decisions);
      setMsg({ text: `Applied ${result.applied ?? decisions.length} decision(s).` });
      await recon.reload();
      list.reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const batch = recon.data?.batch;
  const confirmed = batch?.confirmed_at || batch?.is_complete_snapshot;

  return (
    <div>
      <PageHeader
        title="Update trailer list"
        subtitle="Upload photos of the official trailer list, review the differences, then confirm the changes."
        actions={
          selectedId ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSelectedId(null)}
            >
              Back to batches
            </button>
          ) : null
        }
      />
      <Alert message={msg} />

      {!selectedId ? (
        <>
          <UploadCard
            onUploaded={(r) => {
              list.reload();
              if (r?.batch?.id) setSelectedId(r.batch.id);
            }}
            setMsg={setMsg}
          />
          {list.error && <div className="alert alert-danger">{list.error}</div>}
          {list.loading ? (
            <div className="loading">Loading…</div>
          ) : !list.data?.rows?.length ? (
            <Empty>No import batches yet.</Empty>
          ) : (
            <Table
              rows={list.data.rows}
              columns={COLUMNS}
              onRow={(row) => setSelectedId(row.id)}
            />
          )}
        </>
      ) : (
        <>
          {recon.error && <div className="alert alert-danger">{recon.error}</div>}
          {recon.loading || !recon.data ? (
            <div className="loading">Loading…</div>
          ) : (
            <>
              <div className="trailer-actions" style={{ marginBottom: 12 }}>
                <Status value={batch?.status} />
                {!confirmed && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={confirm}
                  >
                    Confirm complete snapshot
                  </button>
                )}
              </div>
              {!confirmed && (
                <p className="trailer-help">
                  Confirm the batch is the complete list before applying decisions —
                  it is what makes "missing from the snapshot" meaningful.
                </p>
              )}
              <ReconciliationPanel data={recon.data} busy={busy} onApply={apply}
                trailers={assets.data?.trailers || []} />
            </>
          )}
        </>
      )}
    </div>
  );
}
