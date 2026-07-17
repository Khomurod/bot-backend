import React, { useState } from "react";
import api from "../../../api/trailerAgreements";
import { Alert, PageHeader } from "../TrailerUi";
import { EMPTY_TERMS, emptyItem } from "./agreementConstants";
import {
  ReviewStep,
  SummaryStep,
  TermsStep,
  TrailersStep,
} from "./AgreementBuilderSteps";

const STEPS = ["Company & terms", "Trailers", "Pricing", "Review"];

function itemPayload(item) {
  return {
    trailer_id: Number(item.trailer_id),
    item_status: "scheduled",
    scheduled_pickup_at: item.scheduled_pickup_at
      ? new Date(item.scheduled_pickup_at).toISOString()
      : null,
    expected_return_at: item.expected_return_at
      ? new Date(item.expected_return_at).toISOString()
      : null,
    pickup_location: item.pickup_location || null,
    pricing_mode: item.pricing_mode,
    daily_rate: item.daily_rate ? Number(item.daily_rate) : null,
    weekly_rate: item.weekly_rate ? Number(item.weekly_rate) : null,
    monthly_rate: item.monthly_rate ? Number(item.monthly_rate) : null,
    flat_amount: item.flat_amount ? Number(item.flat_amount) : null,
    additional_amount: Number(item.additional_amount || 0),
    discount_amount: Number(item.discount_amount || 0),
    notes: item.notes || null,
  };
}

/**
 * Four-step agreement builder. Always creates a DRAFT; scheduling/activation is
 * done later from the detail page. Step state survives back/forward navigation
 * and a failed create, so nothing is retyped after a recoverable error.
 */
export default function AgreementBuilder({ companies, trailers, onCancel, onCreated }) {
  const [step, setStep] = useState(0);
  const [terms, setTerms] = useState({ ...EMPTY_TERMS });
  const [items, setItems] = useState([emptyItem()]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const stepValid = () => {
    if (step === 0) return Boolean(terms.company_id);
    if (step === 1) return items.every((it) => it.trailer_id);
    return true;
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.createAgreement({
        company_id: Number(terms.company_id),
        pricing_mode: terms.pricing_mode,
        agreement_date: terms.agreement_date || null,
        deposit_amount: Number(terms.deposit_amount || 0),
        agreement_discount: Number(terms.agreement_discount || 0),
        payment_terms: terms.payment_terms || null,
        payment_grace_period_days: Number(terms.payment_grace_period_days || 0),
        billing_timezone: terms.billing_timezone || "America/Chicago",
        notes: terms.notes || null,
        items: items.map(itemPayload),
      });
      onCreated(result.agreement);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="New agreement"
        subtitle={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`}
        actions={
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        }
      />
      {error && <Alert message={{ type: "error", text: error }} />}
      {step === 0 && (
        <TermsStep terms={terms} setTerms={setTerms} companies={companies} />
      )}
      {step === 1 && (
        <TrailersStep items={items} setItems={setItems} trailers={trailers} />
      )}
      {step === 2 && (
        <SummaryStep terms={terms} items={items} trailers={trailers} />
      )}
      {step === 3 && (
        <ReviewStep
          terms={terms}
          items={items}
          companies={companies}
          trailers={trailers}
        />
      )}
      <div className="trailer-actions" style={{ marginTop: 16 }}>
        {step > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!stepValid()}
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !stepValid()}
            onClick={create}
          >
            {busy ? "Creating…" : "Create draft agreement"}
          </button>
        )}
      </div>
    </div>
  );
}
