import React, { useState } from "react";
import api from "../../../api/trailerAgreements";
import { Alert, Card, Empty, PageHeader, Status, useLoad } from "../TrailerUi";
import { money, readableStatus } from "./agreementConstants";
import AgreementItemDialog from "./AgreementItemDialog";

const DIALOG_ACTIONS = new Set(["schedule", "return", "extend", "replace", "remove"]);

// Which buttons make sense for an item in a given state. The server stays
// authoritative — this only avoids offering obviously-invalid actions.
function itemActions(status) {
  if (status === "draft") return ["schedule", "activate", "replace", "remove"];
  if (status === "scheduled") return ["activate", "schedule", "extend", "replace", "remove"];
  if (status === "active") return ["return", "extend"];
  return [];
}

function AmendmentList({ amendments }) {
  if (!amendments?.length) return <Empty>No amendments recorded.</Empty>;
  return (
    <table className="trailer-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Type</th>
          <th>Change</th>
          <th>Reason</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {amendments.map((a) => (
          <tr key={a.id}>
            <td>{a.amendment_number}</td>
            <td>{readableStatus(a.amendment_type)}</td>
            <td>{a.change_amount != null ? money(a.change_amount) : "—"}</td>
            <td>{a.reason || "—"}</td>
            <td>{a.created_at ? new Date(a.created_at).toLocaleString() : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AgreementDetail({ agreementId, trailers, onBack }) {
  const load = useLoad(() => api.getAgreement(agreementId), [agreementId]);
  const [dialog, setDialog] = useState(null); // { action, item }
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const unit = (id) =>
    trailers.find((t) => String(t.id) === String(id))?.unit_number || `#${id}`;

  const run = async (fn, okText) => {
    setBusy(true);
    try {
      await fn();
      setMsg({ text: okText });
      await load.reload();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const submitDialog = async (payload) => {
    const { action, item } = dialog;
    const id = agreementId;
    if (action === "schedule") await api.scheduleItem(id, item.id, payload);
    else if (action === "return") await api.returnItem(id, item.id, payload);
    else if (action === "extend")
      await api.extendItem(id, item.id, payload.expected_return_at, payload.reason);
    else if (action === "replace")
      await api.replaceItem(id, item.id, payload.item, payload.reason);
    else if (action === "remove") await api.removeItem(id, item.id, payload.reason);
    setDialog(null);
    setMsg({ text: "Amendment applied." });
    await load.reload();
  };

  const onAction = (action, item) => {
    if (DIALOG_ACTIONS.has(action)) return setDialog({ action, item });
    if (action === "activate")
      return run(() => api.activateItem(agreementId, item.id), "Trailer activated.");
  };

  const agreement = load.data?.agreement;
  const items = load.data?.items || [];
  const amendments = load.data?.amendments || [];

  return (
    <div>
      <PageHeader
        title={agreement ? agreement.agreement_number : "Agreement"}
        subtitle={agreement ? `Status: ${readableStatus(agreement.status)}` : undefined}
        actions={
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Back to list
          </button>
        }
      />
      <Alert message={msg} />
      {load.error && <div className="alert alert-danger">{load.error}</div>}
      {load.loading || !agreement ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          <div className="trailer-summary">
            <Status value={agreement.status} />
            <span>Pricing: {readableStatus(agreement.pricing_mode)}</span>
            <span>Agreed: {money(agreement.current_agreed_amount)}</span>
            <span>Deposit: {money(agreement.deposit_amount)}</span>
          </div>
          <div className="trailer-actions" style={{ margin: "12px 0" }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                run(() => api.combinedInvoice(agreementId), "Combined invoice generated.")
              }
            >
              Generate combined invoice
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => run(() => api.closeAgreement(agreementId), "Agreement closed.")}
            >
              Close agreement
            </button>
          </div>
          <h3>Trailers</h3>
          {!items.length ? (
            <Empty>No trailers on this agreement.</Empty>
          ) : (
            items.map((item) => (
              <Card key={item.id}>
                <div
                  className="trailer-actions"
                  style={{ justifyContent: "space-between" }}
                >
                  <strong>{unit(item.trailer_id)}</strong>
                  <Status value={item.item_status} />
                </div>
                <div className="trailer-summary">
                  <span>Mode: {readableStatus(item.pricing_mode)}</span>
                  <span>
                    Expected return:{" "}
                    {item.expected_return_at
                      ? new Date(item.expected_return_at).toLocaleString()
                      : "—"}
                  </span>
                </div>
                <div className="trailer-actions">
                  {itemActions(item.item_status).map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="btn btn-sm btn-secondary"
                      disabled={busy}
                      onClick={() => onAction(action, item)}
                    >
                      {readableStatus(action)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => api.itemInvoice(agreementId, item.id),
                        "Item invoice generated.",
                      )
                    }
                  >
                    Separate invoice
                  </button>
                </div>
              </Card>
            ))
          )}
          <h3>Amendments</h3>
          <AmendmentList amendments={amendments} />
        </>
      )}
      {dialog && (
        <AgreementItemDialog
          action={dialog.action}
          item={dialog.item}
          trailers={trailers}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      )}
    </div>
  );
}
