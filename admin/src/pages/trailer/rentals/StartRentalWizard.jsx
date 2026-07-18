import React, { useState } from "react";
import ag from "../../../api/trailerAgreements";
import dept from "../../../api/trailerDepartment";
import { Field, Modal, PageHeader } from "../TrailerUi";
import { EMPTY_TERMS, emptyItem } from "../agreement/agreementConstants";
import { TrailersStep } from "../agreement/AgreementBuilderSteps";
import Combobox from "../a11y/Combobox";
import { companyDefaults } from "../a11y/comboboxFilter";
import PriceStep from "./PriceStep";
import { PRICING_CHOICES, priceBlockers, buildPricingPayload, rateField } from "./priceStepModel";

const STEPS = ["Who is renting", "Which trailers", "Price", "Review"];

function itemPayload(item) {
  const hasDates = item.scheduled_pickup_at && item.expected_return_at;
  return {
    trailer_id: Number(item.trailer_id),
    item_status: hasDates ? "scheduled" : "draft",
    scheduled_pickup_at: item.scheduled_pickup_at
      ? new Date(item.scheduled_pickup_at).toISOString() : null,
    expected_return_at: item.expected_return_at
      ? new Date(item.expected_return_at).toISOString() : null,
    pickup_location: item.pickup_location || null,
    pricing_mode: item.pricing_mode,
    included_in_bundle: item.included_in_bundle === true,
    daily_rate: item.daily_rate ? Number(item.daily_rate) : null,
    weekly_rate: item.weekly_rate ? Number(item.weekly_rate) : null,
    monthly_rate: item.monthly_rate ? Number(item.monthly_rate) : null,
    flat_amount: item.flat_amount ? Number(item.flat_amount) : null,
    additional_amount: Number(item.additional_amount || 0),
    discount_amount: Number(item.discount_amount || 0),
    deposit_allocation: Number(item.deposit_allocation || 0),
    notes: item.notes || null,
  };
}

/** Small inline "add a company" form so the wizard never dead-ends. */
function AddCompanyModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ display_name: "", legal_name: "", contact_name: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch) => setForm({ ...form, ...patch });
  const create = async () => {
    if (!form.display_name.trim()) { setError("A company name is required."); return; }
    setBusy(true);
    setError("");
    try {
      const { company } = await dept.createCompany({ ...form, legal_name: form.legal_name || form.display_name });
      onCreated(company);
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title="Add a company" onClose={busy ? undefined : onClose}>
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="trailer-form-grid">
        <Field label="Company name"><input required value={form.display_name} onChange={(e) => set({ display_name: e.target.value })} /></Field>
        <Field label="Legal name (optional)"><input value={form.legal_name} onChange={(e) => set({ legal_name: e.target.value })} /></Field>
        <Field label="Contact person (optional)"><input value={form.contact_name} onChange={(e) => set({ contact_name: e.target.value })} /></Field>
        <Field label="Phone (optional)"><input value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Email (optional)"><input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></Field>
      </div>
      <div className="trailer-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={create}>
          {busy ? "Adding…" : "Add company"}
        </button>
      </div>
    </Modal>
  );
}

function WhoStep({ terms, setTerms, companies, onAddCompany }) {
  const [advanced, setAdvanced] = useState(false);
  const set = (patch) => setTerms({ ...terms, ...patch });
  const company = companies.find((c) => String(c.id) === String(terms.company_id));

  // Selecting a company auto-applies its defaults (contact, terms, rate,
  // timezone, grace) so the employee doesn't re-enter them; defined fields only.
  const selectCompany = (companyId) => {
    const picked = companies.find((c) => String(c.id) === String(companyId));
    const d = companyDefaults(picked);
    set({
      company_id: companyId,
      ...(d.payment_terms != null ? { payment_terms: d.payment_terms } : {}),
      ...(d.billing_timezone != null ? { billing_timezone: d.billing_timezone } : {}),
      ...(d.payment_grace_period_days != null ? { payment_grace_period_days: d.payment_grace_period_days } : {}),
      ...(d.default_daily_rate != null ? { default_daily_rate: d.default_daily_rate } : {}),
    });
  };

  return (
    <div>
      <div className="trailer-form-grid">
        <Field label="Company that is renting">
          <Combobox
            options={companies.map((c) => ({ value: String(c.id), label: c.display_name, hint: c.contact_name || "" }))}
            value={terms.company_id}
            onChange={selectCompany}
            placeholder="Search companies by name…"
            label="Company that is renting"
            emptyText="No matching company — add one below"
          />
        </Field>
        <button type="button" className="btn btn-secondary" onClick={onAddCompany}>
          Add a new company
        </button>
        {company && (
          <div className="trailer-help" role="status">
            {company.contact_name ? `Contact: ${company.contact_name}. ` : ""}
            {terms.payment_terms ? `Terms: ${terms.payment_terms}. ` : ""}
            {terms.billing_timezone ? `Billing timezone: ${terms.billing_timezone}. ` : ""}
            {Number(terms.payment_grace_period_days) ? `Grace: ${terms.payment_grace_period_days} days.` : ""}
          </div>
        )}
        <Field label="Start date">
          <input type="date" value={terms.agreement_date} onChange={(e) => set({ agreement_date: e.target.value })} />
        </Field>
        {/* Deposit belongs to the Price step, not here (§1). */}
      </div>
      <button type="button" className="btn btn-link" onClick={() => setAdvanced(!advanced)}>
        {advanced ? "Hide advanced options" : "Advanced options"}
      </button>
      {advanced && (
        <div className="trailer-form-grid">
          <Field label="Payment terms (optional)">
            <input value={terms.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} />
          </Field>
          <Field label="Grace period (days)">
            <input type="number" min="0" step="1" value={terms.payment_grace_period_days}
              onChange={(e) => set({ payment_grace_period_days: e.target.value })} />
          </Field>
          <Field label="Billing timezone">
            <input value={terms.billing_timezone} onChange={(e) => set({ billing_timezone: e.target.value })} />
          </Field>
          <Field label="Overall discount">
            <input type="number" min="0" step="0.01" value={terms.agreement_discount}
              onChange={(e) => set({ agreement_discount: e.target.value })} />
          </Field>
          <Field label="Notes (optional)">
            <textarea value={terms.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * Start-a-rental wizard: Who is renting → Which trailers → Price → Review.
 * State survives back/forward navigation and a failed create; conflicts come
 * back from the server in plain language ("Trailer X is already booked…").
 * The rental is ALWAYS created as a draft/scheduled — pickup happens later
 * through the guided pickup checklist.
 */
export default function StartRentalWizard({ companies, trailers, onCancel, onCreated, onCompanyAdded }) {
  const [step, setStep] = useState(0);
  const [terms, setTerms] = useState({ ...EMPTY_TERMS });
  const [items, setItems] = useState([emptyItem()]);
  // The Price step: one of the three plain-language charging choices.
  const [price, setPrice] = useState({
    choice: "per_trailer", totalAmount: "", manualAmount: "", manualReason: "",
    deposit: "", discount: "",
  });
  const [addingCompany, setAddingCompany] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Any entered data makes the draft "dirty" — leaving then needs confirmation.
  const dirty = Boolean(terms.company_id) || items.some((it) => it.trailer_id)
    || Boolean(price.totalAmount) || Boolean(price.manualAmount) || Boolean(terms.notes);
  const requestCancel = () => { if (dirty) setConfirmLeave(true); else onCancel(); };

  // Only official trailers that are physically AVAILABLE can be chosen — an
  // "unknown"-condition trailer is not offered as an ordinary selectable one.
  const selectable = trailers.filter((t) => t.physical_status === "available");

  const priceMissing = priceBlockers(price.choice, { ...price, items });
  const stepValid = () => {
    if (step === 0) return Boolean(terms.company_id);
    if (step === 1) return items.length > 0 && items.every((it) => it.trailer_id);
    if (step === 2) return priceMissing.length === 0;
    return true;
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const { agreement, itemPatch } = buildPricingPayload(price.choice, {
        ...price, notes: terms.notes || null,
      });
      const result = await ag.createAgreement({
        company_id: Number(terms.company_id),
        agreement_date: terms.agreement_date || null,
        start_date: terms.agreement_date || null,
        payment_terms: terms.payment_terms || null,
        payment_grace_period_days: Number(terms.payment_grace_period_days || 0),
        billing_timezone: terms.billing_timezone || "America/Chicago",
        ...agreement,
        items: items.map((it) => itemPayload({ ...it, ...itemPatch(it) })),
      });
      onCreated(result.agreement, items.length);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Start a rental"
        subtitle={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`}
        actions={<button type="button" className="btn btn-ghost" onClick={requestCancel}>Cancel</button>}
      />
      {error && <div className="alert alert-danger">{error}</div>}
      {step === 0 && (
        <WhoStep terms={terms} setTerms={setTerms} companies={companies}
          onAddCompany={() => setAddingCompany(true)} />
      )}
      {step === 1 && (
        <TrailersStep items={items} setItems={setItems} trailers={selectable} showPricing={false} />
      )}
      {step === 2 && (
        <PriceStep price={price} setPrice={setPrice} items={items} setItems={setItems} terms={terms} />
      )}
      {step === 3 && (
        <div className="trailer-summary trailer-summary-stack">
          <span>Company: <b>{companies.find((c) => String(c.id) === String(terms.company_id))?.display_name || "—"}</b></span>
          {items.map((it, i) => {
            const unit = trailers.find((t) => String(t.id) === String(it.trailer_id))?.unit_number || `#${it.trailer_id}`;
            return (
              <span key={i}>
                Trailer <b>{unit}</b>
                {it.scheduled_pickup_at ? ` — pickup ${new Date(it.scheduled_pickup_at).toLocaleString()}` : ""}
                {it.expected_return_at ? `, return ${new Date(it.expected_return_at).toLocaleString()}` : ""}
                {it.pickup_location ? ` at ${it.pickup_location}` : ""}
                {price.choice === "per_trailer"
                  ? ` — $${Number(it[rateField(it.pricing_mode)] || 0).toFixed(2)} ${it.pricing_mode}` : ""}
              </span>
            );
          })}
          <span>Pricing: {PRICING_CHOICES.find((c) => c.value === price.choice)?.label}</span>
          {price.choice === "total" && <span>Total agreed amount: <b>${Number(price.totalAmount || 0).toFixed(2)}</b></span>}
          {price.choice === "manual" && <span>Final agreed amount: <b>${Number(price.manualAmount || 0).toFixed(2)}</b> ({price.manualReason})</span>}
          {Number(price.deposit) > 0 && <span>Deposit: ${Number(price.deposit).toFixed(2)}</span>}
          {Number(price.discount) > 0 && <span>Discount: −${Number(price.discount).toFixed(2)}</span>}
          <p className="trailer-help">
            The rental starts as “being set up”. Next you will complete the pickup
            inspection and photos for each trailer, then confirm each pickup.
          </p>
        </div>
      )}
      <div className="trailer-actions" style={{ marginTop: 16 }}>
        {step > 0 && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn btn-primary" disabled={!stepValid()} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy || !stepValid()} onClick={create}>
            {busy ? "Creating…" : "Create rental"}
          </button>
        )}
      </div>
      {addingCompany && (
        <AddCompanyModal
          onClose={() => setAddingCompany(false)}
          onCreated={(company) => {
            setAddingCompany(false);
            setTerms({ ...terms, company_id: String(company.id) });
            onCompanyAdded?.(company);
          }}
        />
      )}
      {confirmLeave && (
        <Modal title="Discard this rental draft?" onClose={() => setConfirmLeave(false)}>
          <p>You have unsaved rental details. Discarding will lose them.</p>
          <div className="trailer-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmLeave(false)}>
              Continue editing
            </button>
            <button type="button" className="btn btn-danger" onClick={onCancel}>
              Discard draft
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
