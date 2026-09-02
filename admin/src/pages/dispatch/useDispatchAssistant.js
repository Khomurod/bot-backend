import { useState, useEffect, useCallback } from "react";
import * as api from "../../api";
import {
  ACCEPTED_MIME_TYPES, normalizeClipboardFile, formatGroupLabel,
  stripRateLine, resolveChatId,
} from "./helpers";

/**
 * The Send Load tab: upload or paste a rate confirmation, parse it, and send
 * the result to one Telegram group.
 *
 * PASTE IS A WINDOW-LEVEL LISTENER, because a dispatcher's habit is Ctrl+V
 * straight onto the page rather than clicking a file field first. It is
 * suppressed while a parse is in flight so a second paste cannot overwrite the
 * result of the first.
 *
 * The group list always leads with the Management Group, and keeps it even when
 * the group fetch FAILS — with no chat id, so the dispatcher can paste one by
 * hand. That fallback is why a groups outage does not block sending.
 *
 * The parsed text is what gets sent, verbatim, minus the rate line when the
 * admin unticks "with rate". The original file rides along as a document only
 * when "with rate confirmation" is ticked.
 *
 * Split out of admin/src/pages/DispatchPage.jsx.
 */
export function useDispatchAssistant(setMessage) {
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [resultText, setResultText] = useState("");
  const [activeFileName, setActiveFileName] = useState("");
  const [sourceFile, setSourceFile] = useState(null);
  const [copying, setCopying] = useState(false);
  const [groups, setGroups] = useState([]);
  const [selectedGroupInput, setSelectedGroupInput] = useState("");
  const [withRate, setWithRate] = useState(true);
  const [withRateConfirmation, setWithRateConfirmation] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const loadGroups = async () => {
      try {
        const data = await api.getGroups();
        if (!isMounted) return;

        const rawGroups = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
        const managementGroupId = Array.isArray(data)
          ? ""
          : String(data?.managementGroupId || "").trim();

        const managementGroup = {
          id: "management-group",
          group_name: "Management Group",
          telegram_group_id: managementGroupId,
          driver_first_name: "",
          driver_last_name: "",
          label: managementGroupId
            ? `Management Group | ${managementGroupId}`
            : "Management Group | Paste chat ID manually",
        };

        const mappedGroups = rawGroups.map((group) => ({
          ...group,
          label: formatGroupLabel(group),
        }));

        const uniqueGroups = mappedGroups.filter(
          (group) => String(group.telegram_group_id || "") !== managementGroupId
        );
        const nextGroups = [managementGroup, ...uniqueGroups];

        setGroups(nextGroups);
        setSelectedGroupInput((current) => (
          current || (managementGroupId ? managementGroup.label : current)
        ));
      } catch (err) {
        if (!isMounted) return;
        setGroups([
          {
            id: "management-group",
            group_name: "Management Group",
            telegram_group_id: "",
            driver_first_name: "",
            driver_last_name: "",
            label: "Management Group | Paste chat ID manually",
          },
        ]);
      }
    };

    loadGroups();
    return () => {
      isMounted = false;
    };
  }, []);

  const uploadFile = useCallback(async (inputFile) => {
    const file = normalizeClipboardFile(inputFile);
    if (!file) return;

    if (!ACCEPTED_MIME_TYPES.has(file.type)) {
      setMessage({ type: "error", text: "Please upload a PDF, JPG, PNG, or WEBP file." });
      return;
    }

    setLoading(true);
    setMessage(null);
    setActiveFileName(file.name);
    setSourceFile(file);

    try {
      const data = await api.parseDispatchRateCon(file);
      setResultText(data.text || "");
      setMessage({ type: "success", text: "Rate confirmation parsed successfully." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const handlePaste = (event) => {
      if (loading) return;

      const fileItem = Array.from(event.clipboardData?.items || []).find(
        (item) => item.kind === "file"
      );
      if (!fileItem) return;

      const pastedFile = fileItem.getAsFile();
      if (!pastedFile) return;

      event.preventDefault();
      uploadFile(pastedFile);
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [loading, uploadFile]);

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      await uploadFile(file);
    }
    event.target.value = "";
  };

  const handleCopy = async () => {
    if (!resultText) return;

    setCopying(true);
    try {
      await navigator.clipboard.writeText(resultText);
      setMessage({ type: "success", text: "Formatted load copied to clipboard." });
    } catch (err) {
      setMessage({ type: "error", text: "Copy failed. Please copy the text manually." });
    } finally {
      setCopying(false);
    }
  };

  const handleSendToTelegram = async () => {
    const chatId = resolveChatId(selectedGroupInput, groups);
    if (!chatId) {
      setMessage({ type: "error", text: "Select a group from the list or paste a valid Telegram chat ID." });
      return;
    }

    let finalText = resultText.trim();
    if (!finalText) {
      setMessage({ type: "error", text: "There is no parsed load text to send yet." });
      return;
    }

    if (!withRate) {
      finalText = stripRateLine(finalText);
    }

    const formData = new FormData();
    formData.append("chatId", chatId);
    formData.append("messageText", finalText);
    if (withRateConfirmation && sourceFile) {
      formData.append("document", sourceFile);
    }

    setSending(true);
    setMessage(null);

    try {
      await api.sendDispatchToTelegram(formData);
      setMessage({ type: "success", text: "Dispatch load sent to Telegram successfully." });
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSending(false);
    }
  };

  return {
    loading, sending, resultText, setResultText, activeFileName, sourceFile,
    copying, groups, selectedGroupInput, setSelectedGroupInput,
    withRate, setWithRate, withRateConfirmation, setWithRateConfirmation,
    uploadFile, handleFileChange, handleCopy, handleSendToTelegram,
  };
}
