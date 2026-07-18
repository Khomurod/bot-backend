import React from "react";
import { Card, Field } from "../TrailerUi";
import Combobox from "../a11y/Combobox";
import { trailerPickerOptions } from "../a11y/comboboxFilter";
import {
  AGREEMENT_PRICING_MODES,
  PRICING_MODES,
  emptyItem,
  money,
} from "./agreementConstants";
import { summarize } from "./agreementPricing";

/** Step 1 — renter company and agreement-level terms. */
export function TermsStep({ terms, setTerms, companies }) {
  const set = (patch) => setTerms({ ...terms, ...patch });
  return (
    <div className="trailer-form-grid">
      <Field label="Renter company">
        <select
          required
          value={terms.company_id}
          onChange={(e) => set({ company_id: e.target.value })}
        >
          <option value="">Select…</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Pricing mode">
        <select
          value={terms.pricing_mode}
          onChange={(e) => set({ pricing_mode: e.target.value })}
        >
          {AGREEMENT_PRICING_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Agreement date">
        <input
          type="date"
          value={terms.agreement_date}
          onChange={(e) => set({ agreement_date: e.target.value })}
        />
      </Field>
      <Field label="Deposit amount">
        <input
          type="number"
          min="0"
          step="0.01"
          value={terms.deposit_amount}
          onChange={(e) => set({ deposit_amount: e.target.value })}
        />
      </Field>
      <Field label="Agreement discount">
        <input
          type="number"
          min="0"
          step="0.01"
          value={terms.agreement_discount}
          onChange={(e) => set({ agreement_discount: e.target.value })}
        />
      </Field>
      <Field label="Payment terms">
        <input
          value={terms.payment_terms}
          onChange={(e) => set({ payment_terms: e.target.value })}
        />
      </Field>
      <Field label="Grace period (days)">
        <input
          type="number"
          min="0"
          step="1"
          value={terms.payment_grace_period_days}
          onChange={(e) => set({ payment_grace_period_days: e.target.value })}
        />
      </Field>
      <Field label="Billing timezone">
        <input
          value={terms.billing_timezone}
          onChange={(e) => set({ billing_timezone: e.target.value })}
        />
      </Field>
      <Field label="Notes">
        <textarea
          value={terms.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </Field>
    </div>
  );
}

function ItemRow({ item, index, trailers, onChange, onRemove, canRemove, excludeIds = [] }) {
  const set = (patch) => onChange(index, { ...item, ...patch });
  const mode = item.pricing_mode;
  // Searchable picker options exclude trailers already chosen in OTHER rows, so
  // the same trailer can't be selected twice, while keeping this row's pick.
  const trailerOptions = trailerPickerOptions(trailers, item.trailer_id, excludeIds);
  return (
    <Card>
      <div className="trailer-actions" style={{ justifyContent: "space-between" }}>
        <strong>Trailer {index + 1}</strong>
        {canRemove && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onRemove(index)}
          >
            Remove
          </button>
        )}
      </div>
      <div className="trailer-form-grid">
        <Field label="Trailer">
          <Combobox
            options={trailerOptions}
            value={item.trailer_id}
            onChange={(value) => set({ trailer_id: value })}
            placeholder="Search trailers by unit…"
            label="Trailer"
            emptyText="No available trailer matches"
          />
        </Field>
        <Field label="Pricing mode">
          <select value={mode} onChange={(e) => set({ pricing_mode: e.target.value })}>
            {PRICING_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scheduled pickup">
          <input
            type="datetime-local"
            value={item.scheduled_pickup_at}
            onChange={(e) => set({ scheduled_pickup_at: e.target.value })}
          />
        </Field>
        <Field label="Expected return">
          <input
            type="datetime-local"
            value={item.expected_return_at}
            onChange={(e) => set({ expected_return_at: e.target.value })}
          />
        </Field>
        {mode === "daily" && (
          <Field label="Daily rate">
            <input
              type="number"
              min="0"
              step="0.01"
              value={item.daily_rate}
              onChange={(e) => set({ daily_rate: e.target.value })}
            />
          </Field>
        )}
        {mode === "weekly" && (
          <Field label="Weekly rate">
            <input
              type="number"
              min="0"
              step="0.01"
              value={item.weekly_rate}
              onChange={(e) => set({ weekly_rate: e.target.value })}
            />
          </Field>
        )}
        {mode === "monthly" && (
          <Field label="Monthly rate">
            <input
              type="number"
              min="0"
              step="0.01"
              value={item.monthly_rate}
              onChange={(e) => set({ monthly_rate: e.target.value })}
            />
          </Field>
        )}
        {mode === "flat" && (
          <Field label="Flat amount">
            <input
              type="number"
              min="0"
              step="0.01"
              value={item.flat_amount}
              onChange={(e) => set({ flat_amount: e.target.value })}
            />
          </Field>
        )}
        <Field label="Pickup location">
          <input
            value={item.pickup_location}
            onChange={(e) => set({ pickup_location: e.target.value })}
          />
        </Field>
        <Field label="Additional amount">
          <input
            type="number"
            min="0"
            step="0.01"
            value={item.additional_amount}
            onChange={(e) => set({ additional_amount: e.target.value })}
          />
        </Field>
        <Field label="Item discount">
          <input
            type="number"
            min="0"
            step="0.01"
            value={item.discount_amount}
            onChange={(e) => set({ discount_amount: e.target.value })}
          />
        </Field>
        <Field label="Notes">
          <input
            value={item.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </Field>
      </div>
    </Card>
  );
}

/** Step 2 — repeatable trailer rows. */
export function TrailersStep({ items, setItems, trailers }) {
  const change = (index, next) =>
    setItems(items.map((it, i) => (i === index ? next : it)));
  const remove = (index) => setItems(items.filter((_, i) => i !== index));
  return (
    <div>
      {items.map((item, index) => (
        <ItemRow
          key={index}
          item={item}
          index={index}
          trailers={trailers}
          excludeIds={items.filter((_, i) => i !== index).map((it) => it.trailer_id).filter(Boolean)}
          onChange={change}
          onRemove={remove}
          canRemove={items.length > 1}
        />
      ))}
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setItems([...items, emptyItem()])}
      >
        Add another trailer
      </button>
    </div>
  );
}

/** Step 3 — client-computed pricing summary. */
export function SummaryStep({ terms, items, trailers }) {
  const unit = (id) =>
    trailers.find((t) => String(t.id) === String(id))?.unit_number || "—";
  const { lines, itemsTotal, agreementDiscount, deposit, netDue } = summarize(
    terms,
    items,
  );
  return (
    <div>
      <table className="trailer-table">
        <thead>
          <tr>
            <th>Trailer</th>
            <th>Mode</th>
            <th>Days</th>
            <th>Base</th>
            <th>Line total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td>{unit(line.item.trailer_id)}</td>
              <td>{line.item.pricing_mode}</td>
              <td>{line.days || "—"}</td>
              <td>{money(line.base)}</td>
              <td>{money(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="trailer-summary">
        <span>Items total: {money(itemsTotal)}</span>
        <span>Agreement discount: {money(agreementDiscount)}</span>
        <span>Deposit: {money(deposit)}</span>
        <strong>Estimated net due: {money(netDue)}</strong>
      </div>
      <p className="trailer-help">
        Estimate only. Final amounts are computed by the server from the billable
        window at invoice time.
      </p>
    </div>
  );
}

/** Step 4 — review before creating the draft. */
export function ReviewStep({ terms, items, companies, trailers }) {
  const company =
    companies.find((c) => String(c.id) === String(terms.company_id))
      ?.display_name || "—";
  const { netDue } = summarize(terms, items);
  return (
    <div className="trailer-summary">
      <span>Company: {company}</span>
      <span>Pricing mode: {terms.pricing_mode}</span>
      <span>Trailers: {items.length}</span>
      <span>Deposit: {money(terms.deposit_amount)}</span>
      <strong>Estimated net due: {money(netDue)}</strong>
      <p className="trailer-help">
        The agreement is always created as a draft — schedule, activate, and
        invoice each trailer from the agreement detail afterwards.
      </p>
    </div>
  );
}
