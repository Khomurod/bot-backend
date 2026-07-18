import React, { useEffect, useState } from "react";
import ag from "../../../api/trailerAgreements";
import { Field } from "../TrailerUi";
import {
  PRICING_CHOICES, RATE_MODES, rateField, applySameRate, buildPricingPayload,
} from "./priceStepModel";

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

/**
 * Wizard Price step (§1): «How will this rental be charged?» with exactly the
 * three plain-language options. Rate inputs appear only for the mode that is
 * selected, and the estimate is computed ON THE SERVER with the same math
 * invoicing uses — the browser never invents a number.
 */
export default function PriceStep({ price, setPrice, items, setItems, terms }) {
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const set = (patch) => setPrice({ ...price, ...patch });

  // Server-validated estimate, debounced while the employee types.
  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        setEstimating(true);
        const { agreement, itemPatch } = buildPricingPayload(price.choice, price);
        const { estimate: result } = await ag.estimateAgreement({
          ...agreement,
          billing_timezone: terms.billing_timezone,
          items: items.map((it) => ({ ...it, ...itemPatch(it) })),
        });
        setEstimate(result);
      } catch {
        setEstimate(null); // estimate is advisory; creation still validates server-side
      } finally {
        setEstimating(false);
      }
    }, 400);
    return () => clearTimeout(id);
  }, [JSON.stringify(price), JSON.stringify(items)]);

  return (
    <div>
      <fieldset>
        <legend>How will this rental be charged?</legend>
        {PRICING_CHOICES.map((c) => (
          <label className="trailer-check" key={c.value}>
            <input type="radio" name="pricing-choice" checked={price.choice === c.value}
              onChange={() => set({ choice: c.value })} />
            {c.label}
          </label>
        ))}
      </fieldset>

      {price.choice === "total" && (
        <div className="trailer-form-grid">
          <Field label="Total rental price">
            <input type="number" min="0" step="0.01" value={price.totalAmount}
              onChange={(e) => set({ totalAmount: e.target.value })} />
          </Field>
          <Field label="Deposit (optional)">
            <input type="number" min="0" step="0.01" value={price.deposit}
              onChange={(e) => set({ deposit: e.target.value })} />
          </Field>
          <Field label="Discount (optional)">
            <input type="number" min="0" step="0.01" value={price.discount}
              onChange={(e) => set({ discount: e.target.value })} />
          </Field>
        </div>
      )}

      {price.choice === "per_trailer" && (
        <div>
          <button type="button" className="btn btn-secondary"
            onClick={() => setItems(applySameRate(items))}>
            Use the same rate for all trailers
          </button>
          {items.map((it, i) => {
            const field = rateField(it.pricing_mode);
            return (
              <div className="trailer-form-grid" key={i}>
                <strong>Trailer {i + 1}</strong>
                <Field label="Charged">
                  <select value={it.pricing_mode}
                    onChange={(e) => setItems(items.map((x, j) => (j === i
                      ? { ...x, pricing_mode: e.target.value } : x)))}>
                    {RATE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </Field>
                {/* Only the selected mode's input is shown. */}
                <Field label={RATE_MODES.find((m) => m.value === it.pricing_mode)?.label || "Rate"}>
                  <input type="number" min="0" step="0.01" value={it[field] || ""}
                    onChange={(e) => setItems(items.map((x, j) => (j === i
                      ? { ...x, [field]: e.target.value } : x)))} />
                </Field>
              </div>
            );
          })}
          <div className="trailer-form-grid">
            <Field label="Deposit (optional)">
              <input type="number" min="0" step="0.01" value={price.deposit}
                onChange={(e) => set({ deposit: e.target.value })} />
            </Field>
            <Field label="Discount (optional)">
              <input type="number" min="0" step="0.01" value={price.discount}
                onChange={(e) => set({ discount: e.target.value })} />
            </Field>
          </div>
        </div>
      )}

      {price.choice === "manual" && (
        <div className="trailer-form-grid">
          <Field label="Final agreed amount">
            <input type="number" min="0" step="0.01" value={price.manualAmount}
              onChange={(e) => set({ manualAmount: e.target.value })} />
          </Field>
          <Field label="Why is the amount entered manually?">
            <input value={price.manualReason} placeholder="e.g. negotiated package deal"
              onChange={(e) => set({ manualReason: e.target.value })} />
          </Field>
          <Field label="Deposit (optional)">
            <input type="number" min="0" step="0.01" value={price.deposit}
              onChange={(e) => set({ deposit: e.target.value })} />
          </Field>
        </div>
      )}

      <div className="trailer-summary" role="status" aria-live="polite">
        {estimating && <span>Calculating estimate…</span>}
        {!estimating && estimate && (
          <>
            <span>Estimated total: <b>{usd(estimate.total)}</b></span>
            {Number(estimate.discount) > 0 && <span>Discount: −{usd(estimate.discount)}</span>}
            {Number(estimate.deposit) > 0 && <span>Deposit: {usd(estimate.deposit)}</span>}
            <span>Estimated amount due: <b>{usd(estimate.estimated_due)}</b></span>
            {estimate.warnings?.map((w) => (
              <p className="trailer-help" key={w}>{w}</p>
            ))}
            <p className="trailer-help">Calculated on the server with the same math invoices use.</p>
          </>
        )}
      </div>
    </div>
  );
}
