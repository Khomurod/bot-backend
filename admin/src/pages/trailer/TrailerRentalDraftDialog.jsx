import React, { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { Card, Field, PageHeader } from "./TrailerUi";
import { hasTrailerPermission } from "./trailerNavigation";
import { QuickAddCompanyDialog, QuickAddTrailerDialog } from "./TrailerQuickAddDialogs";

const BILLING_METHODS = ["calendar_day", "twenty_four_hour", "manual_days", "flat_rate"];

/**
 * The New Rental Draft. Quick-add overlays render as siblings of this form —
 * never inside it — so adding a trailer or company cannot submit the draft.
 * Every draft field survives a quick-add, success or failure.
 */
export default function TrailerRentalDraftDialog({
  draft,
  setDraft,
  trailers,
  companies,
  onClose,
  onSubmit,
  onQuickAddTrailer,
  onQuickAddCompany,
}) {
  const { permissions } = useAuth();
  const [quickAdd, setQuickAdd] = useState(null);
  const set = (patch) => setDraft({ ...draft, ...patch });
  const canAddTrailer = hasTrailerPermission(permissions, "trailers.create");
  const canAddCompany = hasTrailerPermission(permissions, "trailer_companies.manage");

  return (
    <>
      <div className="trailer-modal-backdrop">
        <Card className="trailer-modal trailer-modal-wide">
          <PageHeader
            title="New rental draft"
            actions={
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
            }
          />
          <form onSubmit={onSubmit} className="trailer-form-grid">
            <Field label="Available trailer">
              <div className="trailer-inline-add">
                <select
                  required
                  value={draft.trailer_id}
                  onChange={(e) => set({ trailer_id: e.target.value })}
                >
                  <option value="">Select…</option>
                  {trailers.map((trailer) => (
                    <option key={trailer.id} value={trailer.id}>
                      {trailer.unit_number}
                    </option>
                  ))}
                </select>
                {canAddTrailer && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setQuickAdd("trailer")}
                  >
                    Add trailer
                  </button>
                )}
              </div>
            </Field>
            <Field label="Renter company">
              <div className="trailer-inline-add">
                <select
                  required
                  value={draft.company_id}
                  onChange={(e) => set({ company_id: e.target.value })}
                >
                  <option value="">Select…</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.display_name}
                    </option>
                  ))}
                </select>
                {canAddCompany && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setQuickAdd("company")}
                  >
                    Add renter company
                  </button>
                )}
              </div>
            </Field>
            <Field label="Pickup date/time">
              <input
                required
                type="datetime-local"
                value={draft.start_at}
                onChange={(e) => set({ start_at: e.target.value })}
              />
            </Field>
            <Field label="Expected return">
              <input
                required
                type="datetime-local"
                value={draft.expected_return_at}
                onChange={(e) => set({ expected_return_at: e.target.value })}
              />
            </Field>
            <Field label="Billing method">
              <select
                value={draft.billing_method}
                onChange={(e) => set({ billing_method: e.target.value })}
              >
                {BILLING_METHODS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            {draft.billing_method === "flat_rate" ? (
              <Field label="Flat rate">
                <input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.flat_rate}
                  onChange={(e) => set({ flat_rate: e.target.value })}
                />
              </Field>
            ) : (
              <Field label="Daily rate">
                <input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.daily_rate}
                  onChange={(e) => set({ daily_rate: e.target.value })}
                />
              </Field>
            )}
            {draft.billing_method === "manual_days" && (
              <>
                <Field label="Agreed billable days">
                  <input
                    required
                    type="number"
                    min="1"
                    step="1"
                    value={draft.manual_billable_days}
                    onChange={(e) => set({ manual_billable_days: e.target.value })}
                  />
                </Field>
                <Field label="Manual-day reason">
                  <input
                    required
                    value={draft.manual_days_reason}
                    onChange={(e) => set({ manual_days_reason: e.target.value })}
                  />
                </Field>
              </>
            )}
            <Field label="Pickup location">
              <input
                required
                value={draft.pickup_location}
                onChange={(e) => set({ pickup_location: e.target.value })}
              />
            </Field>
            <Field label="Notes">
              <textarea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
            <button className="btn btn-primary" type="submit">
              Save draft
            </button>
          </form>
        </Card>
      </div>
      {quickAdd === "trailer" && (
        <QuickAddTrailerDialog
          onClose={() => setQuickAdd(null)}
          onCreate={async (unitNumber) => {
            await onQuickAddTrailer(unitNumber);
            setQuickAdd(null);
          }}
        />
      )}
      {quickAdd === "company" && (
        <QuickAddCompanyDialog
          onClose={() => setQuickAdd(null)}
          onCreate={async (name) => {
            await onQuickAddCompany(name);
            setQuickAdd(null);
          }}
        />
      )}
    </>
  );
}
