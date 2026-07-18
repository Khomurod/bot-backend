import React, { useState } from "react";
import ag from "../../../api/trailerAgreements";
import dept from "../../../api/trailerDepartment";
import { Alert, Card, Empty, PageHeader, useLoad } from "../TrailerUi";
import { invoiceStatus, rentalStatus } from "../trailerStatusVocabulary";
import GuidedPickup from "./GuidedPickup";
import GuidedReturn from "./GuidedReturn";
import AgreementItemDialog from "../agreement/AgreementItemDialog";
import AddTrailerDialog from "./AddTrailerDialog";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const when = (d) => (d ? new Date(d).toLocaleString() : "—");
const TABS = ["Overview", "Trailers", "Documents", "Money", "History"];

function Pill({ map, value }) {
  const s = map(value);
  return <span className={`trailer-pill trailer-pill-${s.tone}`}>{s.label}</span>;
}

/** Custom confirm dialog with an impact summary — never window.confirm(). */
function ConfirmDialog({ title, impact, confirmLabel, onConfirm, onClose, busy }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal trailer-confirm">
        <h3>{title}</h3>
        <p>{impact}</p>
        <div className="trailer-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Keep everything as is
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ItemCard({ rental, item, busy, onAction }) {
  const raw = rental._items?.find((i) => Number(i.id) === Number(item.item_id));
  return (
    <Card className="trailer-item-card">
      <div className="trailer-actions" style={{ justifyContent: "space-between" }}>
        <strong>Trailer {item.unit_number}</strong>
        <Pill map={rentalStatus} value={item.item_status} />
      </div>
      <div className="trailer-summary">
        <span>Pickup: {when(item.actual_pickup_at || item.scheduled_pickup_at)}</span>
        <span>Expected return: {when(item.expected_return_at)}</span>
        <span>
          Inspection: {item.item_status === "active" || item.item_status === "returned"
            ? (item.return_inspection_complete ? "return done" : item.pickup_inspection_complete ? "pickup done" : "—")
            : (item.pickup_inspection_complete ? "pickup done" : "not started")}
        </span>
        <span>Photos: {Number(item.pickup_photo_count || 0) + Number(item.return_photo_count || 0)}</span>
      </div>
      <div className="trailer-actions">
        {item.next_action?.label && (
          <button
            type="button"
            className={`btn btn-sm btn-primary ${item.next_action.urgent ? "trailer-urgent" : ""}`}
            disabled={busy}
            onClick={() => onAction(item.next_action.type, item, raw)}
          >
            {item.next_action.label}
          </button>
        )}
        {["draft", "scheduled", "ready_for_pickup"].includes(item.item_status) && (
          <>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
              onClick={() => onAction("replace", item, raw)}>Swap trailer</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
              onClick={() => onAction("remove", item, raw)}>Remove</button>
          </>
        )}
        {item.item_status === "active" && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
            onClick={() => onAction("extend", item, raw)}>Extend return date</button>
        )}
        {item.item_status === "returned" && !item.invoiced && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
            onClick={() => onAction("item_invoice", item, raw)}>Separate invoice for this trailer</button>
        )}
      </div>
    </Card>
  );
}

/**
 * Rental detail: header with the ONE primary next action, then
 * Overview / Trailers / Documents / Money / History.
 */
export default function RentalDetailPage({ agreementId, onBack, trailers = [] }) {
  const [tab, setTab] = useState("Overview");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState(null); // {kind:'pickup'|'return'|'dialog'|'confirm', ...}

  const overview = useLoad(() => dept.rentalOverview(agreementId).then((r) => r.rental), [agreementId]);
  const detail = useLoad(() => ag.getAgreement(agreementId), [agreementId]);
  const invoicesLoad = useLoad(
    () => dept.invoices({ agreement_id: agreementId }),
    [agreementId],
  );

  const rental = overview.data;
  const reloadAll = async () => { await Promise.all([overview.reload(), detail.reload(), invoicesLoad.reload()]); };

  const run = async (fn, okText) => {
    setBusy(true);
    try {
      await fn();
      setMsg({ text: okText });
      await reloadAll();
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const rawItem = (itemId) => detail.data?.items?.find((i) => Number(i.id) === Number(itemId));

  const onAction = (type, item) => {
    const raw = rawItem(item.item_id) || item;
    const withUnit = { ...raw, unit_number: item.unit_number, pickup_photo_count: item.pickup_photo_count, return_photo_count: item.return_photo_count };
    if (["complete_pickup_inspection", "add_pickup_photos", "confirm_pickup", "schedule_pickup"].includes(type)) {
      if (type === "schedule_pickup" || !raw.scheduled_pickup_at) {
        return setFlow({ kind: "dialog", action: "schedule", item: withUnit });
      }
      return setFlow({ kind: "pickup", item: withUnit });
    }
    if (type === "return_trailer" || type === "complete_return_inspection") {
      return setFlow({ kind: "return", item: withUnit });
    }
    if (type === "complete_rental_details") return setFlow({ kind: "dialog", action: "schedule", item: withUnit });
    if (type === "generate_invoice") return run(() => ag.combinedInvoice(agreementId), "Invoice created.");
    if (type === "record_payment") { setTab("Money"); return undefined; }
    if (type === "close_rental") {
      return setFlow({
        kind: "confirm",
        title: "Complete this rental?",
        impact: "The rental is marked completed. Trailers and invoices keep their full history.",
        confirmLabel: "Complete rental",
        action: () => run(() => ag.closeAgreement(agreementId, rental.version), "Rental completed."),
      });
    }
    if (["extend", "replace", "remove"].includes(type)) return setFlow({ kind: "dialog", action: type, item: withUnit });
    if (type === "item_invoice") return run(() => ag.itemInvoice(agreementId, item.item_id), "Invoice created for this trailer.");
    return undefined;
  };

  const submitDialog = async (payload) => {
    const { action, item } = flow;
    if (action === "schedule") await ag.scheduleItem(agreementId, item.id, { ...payload, version: item.version });
    else if (action === "extend") await ag.extendItem(agreementId, item.id, payload.expected_return_at, payload.reason);
    else if (action === "replace") await ag.replaceItem(agreementId, item.id, payload.item, payload.reason);
    else if (action === "remove") await ag.removeItem(agreementId, item.id, payload.reason);
    setFlow(null);
    setMsg({ text: "Saved." });
    await reloadAll();
  };

  if (overview.loading || !rental) {
    return <div className="loading"><div className="spinner" />Loading…</div>;
  }

  const invoices = Array.isArray(invoicesLoad.data?.invoices) ? invoicesLoad.data.invoices : [];
  const documents = detail.data?.media_summary || [];
  const amendments = detail.data?.amendments || [];

  return (
    <div>
      <PageHeader
        title={`${rental.company.name} — ${rental.display_number}`}
        subtitle={`${rental.trailer_count} trailer${rental.trailer_count === 1 ? "" : "s"} · ${rentalStatus(rental.status).label}${Number(rental.outstanding_amount) > 0 ? ` · ${usd(rental.outstanding_amount)} outstanding` : ""}`}
        actions={
          <div className="trailer-actions">
            {rental.next_action?.label && (
              <button type="button" className="btn btn-primary" disabled={busy}
                onClick={() => onAction(rental.next_action.type,
                  rental.trailers.find((t) => t.item_id === rental.next_action.item_id) || rental.trailers[0] || rental)}>
                {rental.next_action.label}
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={onBack}>Back to rentals</button>
          </div>
        }
      />
      <Alert message={msg} />
      <div className="trailer-section-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            className={`trailer-section-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="trailer-two-col">
          <Card>
            <h3>Rental</h3>
            <div className="trailer-summary trailer-summary-stack">
              <span>Company: <b>{rental.company.name}</b>{rental.company.contact ? ` (${rental.company.contact})` : ""}</span>
              <span>Status: <Pill map={rentalStatus} value={rental.status} /></span>
              <span>First pickup: {when(rental.pickup_at)}</span>
              <span>Last expected return: {when(rental.expected_return_at)}</span>
            </div>
          </Card>
          <Card>
            <h3>Money</h3>
            <div className="trailer-summary trailer-summary-stack">
              <span>Invoiced: {usd(rental.total_amount)}</span>
              <span>Paid: {usd(rental.paid_amount)}</span>
              <span>Outstanding: <b>{usd(rental.outstanding_amount)}</b></span>
            </div>
          </Card>
        </div>
      )}

      {tab === "Trailers" && (
        <div>
          {rental.trailers.map((item) => (
            <ItemCard key={item.item_id} rental={{ _items: detail.data?.items }} item={item}
              busy={busy} onAction={onAction} />
          ))}
          <button type="button" className="btn btn-secondary" disabled={busy}
            onClick={() => setFlow({ kind: "addTrailer" })}>
            Add a trailer to this rental
          </button>
        </div>
      )}

      {tab === "Documents" && (
        <Card>
          {!documents.length
            ? <Empty>No photos or documents yet. They are added during pickup and return.</Empty>
            : (
              <table className="trailer-table">
                <thead><tr><th>Trailer</th><th>Type</th><th>Count</th></tr></thead>
                <tbody>
                  {documents.map((d, i) => (
                    <tr key={i}>
                      <td>{rental.trailers.find((t) => Number(t.item_id) === Number(d.rental_item_id))?.unit_number || "—"}</td>
                      <td>{String(d.media_type || "").replace(/_/g, " ")}</td>
                      <td>{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>
      )}

      {tab === "Money" && (
        <div>
          <div className="trailer-actions" style={{ marginBottom: 12 }}>
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => run(() => ag.combinedInvoice(agreementId), "One invoice created for all trailers.")}>
              One invoice for all trailers
            </button>
          </div>
          {!invoices.length ? <Empty>No invoices yet. Create one after a trailer is returned.</Empty> : (
            <table className="trailer-table">
              <thead><tr><th>Invoice</th><th>Total</th><th>Paid</th><th>Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td>{i.invoice_number}</td>
                    <td>{usd(i.total_amount)}</td>
                    <td>{usd(i.total_paid)}</td>
                    <td>{usd(i.outstanding_balance)}</td>
                    <td><Pill map={invoiceStatus} value={i.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="trailer-help">Record payments in Money → Invoices &amp; payments.</p>
        </div>
      )}

      {tab === "History" && (
        <Card>
          {!amendments.length ? <Empty>No changes recorded yet.</Empty> : (
            <table className="trailer-table">
              <thead><tr><th>#</th><th>Change</th><th>Reason</th><th>When</th></tr></thead>
              <tbody>
                {amendments.map((a) => (
                  <tr key={a.id}>
                    <td>{a.amendment_number}</td>
                    <td>{String(a.amendment_type || "").replace(/_/g, " ")}</td>
                    <td>{a.reason || "—"}</td>
                    <td>{when(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {rental.status !== "closed" && rental.status !== "cancelled" && (
        <div className="trailer-danger-zone">
          <button type="button" className="btn btn-ghost" disabled={busy}
            onClick={() => setFlow({
              kind: "confirm",
              title: "Complete this rental?",
              impact: rental.trailers.some((t) => ["active", "scheduled", "ready_for_pickup", "draft"].includes(t.item_status))
                ? "Some trailers are still out or planned — the server will refuse until they are returned or removed."
                : "The rental is marked completed. Trailers and invoices keep their full history.",
              confirmLabel: "Complete rental",
              action: () => run(() => ag.closeAgreement(agreementId, rental.version), "Rental completed."),
            })}>
            More: complete this rental
          </button>
        </div>
      )}

      {flow?.kind === "pickup" && (
        <GuidedPickup agreementId={agreementId} item={flow.item}
          onClose={() => setFlow(null)}
          onDone={async () => {
            setFlow(null);
            setMsg({ text: `Pickup confirmed — trailer ${flow.item.unit_number} is now rented to ${rental.company.name}.` });
            await reloadAll();
          }} />
      )}
      {flow?.kind === "return" && (
        <GuidedReturn agreementId={agreementId} item={flow.item}
          onClose={() => setFlow(null)}
          onDone={async () => {
            setFlow(null);
            setMsg({ text: `Trailer ${flow.item.unit_number} returned.` });
            await reloadAll();
          }} />
      )}
      {flow?.kind === "dialog" && !flow.addMode && (
        <AgreementItemDialog action={flow.action} item={flow.item} trailers={trailers}
          onClose={() => setFlow(null)} onSubmit={submitDialog} />
      )}
      {flow?.kind === "addTrailer" && (
        <AddTrailerDialog trailers={trailers} existingItems={rental.trailers}
          onClose={() => setFlow(null)}
          onSubmit={async (item, reason) => {
            await ag.addItem(agreementId, item, reason);
            setFlow(null);
            setMsg({ text: `Trailer ${trailers.find((t) => Number(t.id) === Number(item.trailer_id))?.unit_number || ""} added — it is scheduled for pickup.` });
            await reloadAll();
          }} />
      )}
      {flow?.kind === "confirm" && (
        <ConfirmDialog title={flow.title} impact={flow.impact} confirmLabel={flow.confirmLabel}
          busy={busy} onClose={() => setFlow(null)}
          onConfirm={async () => { await flow.action(); setFlow(null); }} />
      )}
    </div>
  );
}
