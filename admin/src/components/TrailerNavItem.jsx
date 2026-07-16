import React from "react";

/**
 * "🏢 Trailer Department" in the main sidebar plus its permitted pages as
 * indented children. The parent opens the department; the caret only expands.
 */
export default function TrailerNavItem({
  item,
  sections,
  active,
  activeSection,
  expanded,
  onToggle,
  onOpenDepartment,
  onSelectSection,
}) {
  return (
    <div className="nav-tree">
      <div className="nav-tree-parent">
        <button
          type="button"
          className={`nav-item ${active ? "active" : ""}`}
          onClick={onOpenDepartment}
        >
          <span className="nav-icon">{item.icon}</span>
          {item.label}
        </button>
        {sections.length > 0 && (
          <button
            type="button"
            className="nav-tree-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${item.label} pages`}
            onClick={onToggle}
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        )}
      </div>
      {expanded && sections.length > 0 && (
        <div className="nav-subitems">
          {sections.map((section) => (
            <button
              type="button"
              key={section.key}
              className={`nav-item nav-subitem ${
                active && activeSection === section.key ? "active" : ""
              }`}
              aria-current={active && activeSection === section.key ? "page" : undefined}
              onClick={() => onSelectSection(section.key)}
            >
              <span className="nav-icon">{section.icon}</span>
              {section.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
