import React from "react";
import TabBar, { tabPanelProps } from "../components/ui/TabBar";
import useTabRoute from "../navigation/useTabRoute";
import CompanyBirthdaysPage from "./CompanyBirthdaysPage";
import CompanyEmployeesTab from "./birthdays/CompanyEmployeesTab";

/**
 * Communications → Birthdays: the company's employees and the birthday wishes
 * posted for them.
 *
 * ONE DOMAIN, ONE PAGE (October 2026). The employee list exists for exactly one
 * thing — the birthday card (American name, Telegram tag, photo) — yet it was
 * under Users → Company Employees, a different sidebar group from the birthdays
 * it is for. Adding a new employee meant two places. The two screens are
 * unchanged; they are now two tabs here, and the open one is in the address
 * (`#company_birthdays/employees`). docs/architecture/employee-birthday-cards.md.
 */
const TABS = [
  { key: "birthdays", label: "Birthdays" },
  { key: "employees", label: "Employees" },
];

export default function BirthdaysPage({ tab: routeTab, onTabChange }) {
  const [tab, setTab] = useTabRoute(TABS.map((t) => t.key), { tab: routeTab, onTabChange });
  return (
    <div>
      <div className="page-header">
        <h2>Birthdays</h2>
        <p>Office staff birthdays, the card each employee gets, and the wishes posted to the employee group.</p>
      </div>
      <TabBar tabs={TABS} value={tab} onChange={setTab} ariaLabel="Birthday sections" idPrefix="birthdays" />
      <div {...tabPanelProps("birthdays", tab)}>
        {tab === "birthdays" && <CompanyBirthdaysPage />}
        {tab === "employees" && <CompanyEmployeesTab />}
      </div>
    </div>
  );
}
