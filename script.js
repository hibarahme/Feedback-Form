(() => {
  "use strict";

  const SECTIONS = [
    {id:"flows", tag:"Flows · AI", title:"Agent Performance & Flows", items:[
      {id:"scenarios", title:"Scenarios", desc:"Each reservation flow works as expected: new booking, modification, cancellation, availability check, indoor/outdoor seating request..."},
      {id:"wording", title:"Wording", desc:"Uses the restaurant's own terms and phrases correctly, the way L'Atelier Entrecôte wants."},
    ]},
    {id:"voice", tag:"Voice · AI", title:"Voice & Conversation", items:[
      {id:"vquality", title:"Voice Quality", desc:"Natural sound, clarity, pace, pronunciation."},
      {id:"understanding", title:"Understanding", desc:"Accents, background noise, different phrasings."},
      {id:"convflow", title:"Conversation Flow", desc:"Response time, interruptions, read-back of details, opening and closing."},
      {id:"tone", title:"Tone of Voice", desc:"Warm, professional, efficient, positive."},
      {id:"languages", title:"Languages", desc:"Switches to the caller's language and speaks it well."},
      {id:"vreq", title:"Requirements", desc:"Changes to greeting, name, voice, wording, languages.", kind:"request"},
    ]},
    {id:"dashboard", tag:"Dashboard · Product", title:"Dashboard: Design & Results", items:[
      {id:"results", title:"Results", desc:"Shows the information you need: calls, bookings, messages, key figures."},
      {id:"accuracy", title:"Accuracy", desc:"Numbers and details match what really happened."},
      {id:"design", title:"Design", desc:"Clear, clean and pleasant to look at."},
      {id:"ease", title:"Ease of Use", desc:"Easy to navigate and find what you need quickly."},
      {id:"dreq", title:"Requirements", desc:"Information or features to add.", kind:"request"},
    ]},
    {id:"extra", tag:"Open", title:"Additional Feedback", items:[
      {id:"general", title:"General Experience", desc:"Overall rating, and note any moments that felt off.", kind:"rating"},
      {id:"additional", title:"Anything else", desc:"Ideas, concerns or anything we didn't ask about.", kind:"request", optional:true, addLabel:"Add note", placeholder:"Share anything else you noticed or would like us to know."},
    ]},
  ];
  const STATUSES = [
    ["ok", "Works well"],
    ["mid", "Needs changes"],
    ["bad", "Not working"],
    ["na", "Not tested"],
  ];
  const STATUS_LABELS = Object.fromEntries(STATUSES);
  const ITEMS = SECTIONS.flatMap(section => section.items);
  const REQUIRED_ITEMS = ITEMS.filter(item => !item.optional);
  const DRAFT_KEY = "atelier-feedback-draft-v1";
  const MAX_FILE_SIZE = 10_000_000;
  const FILE_TYPES = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
    webm: "video/webm", mov: "video/quicktime", pdf: "application/pdf",
  };
  const SUPPORTED_TYPES = new Set(Object.values(FILE_TYPES));
  const ICONS = {
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  };
  const $ = selector => document.querySelector(selector);
  const previewUrls = new Set();
  let saveTimer;
  let pickTarget;
  let uploadClientPromise;
  class FeedbackError extends Error {}
  const openedAt = Date.now();
  let databasePromise;
  let persistedFiles = new Set();
  const fileBlobs = new Map();
  let saveQueue = Promise.resolve();
  let restored = false;
  let requestedPersistence = false;
  let state = loadDraft();

  function createElement(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);
    Object.entries(attributes).forEach(([name, value]) => {
      if (value == null || value === false) return;
      if (name === "text") element.textContent = value;
      else if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
      else element.setAttribute(name, value === true ? "" : value);
    });
    children.forEach(child => { if (child != null) element.append(child); });
    return element;
  }

  function icon(name) {
    const container = document.createElement("span");
    container.innerHTML = ICONS[name];
    container.firstElementChild.setAttribute("aria-hidden", "true");
    return container.firstElementChild;
  }

  function loadDraft() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(DRAFT_KEY)); }
    catch { /* Start with an empty draft when storage is unavailable. */ }
    return normalizeDraft(saved);
  }

  function normalizeDraft(saved) {
    const items = {};
    ITEMS.forEach(item => {
      const previous = saved?.items?.[item.id] || {};
      const notes = Array.isArray(previous.notes) ? previous.notes : [];
      items[item.id] = {
        status: Object.hasOwn(STATUS_LABELS, previous.status) ? previous.status : null,
        rating: Number.isInteger(previous.rating) && previous.rating >= 1 && previous.rating <= 5 ? previous.rating : null,
        notes: notes.filter(note => note && typeof note === "object").map(note => ({
          id: typeof note.id === "string" && /^[\w-]+$/.test(note.id) ? note.id : crypto.randomUUID(),
          text: typeof note.text === "string" ? note.text : "",
          files: Array.isArray(note.files) ? note.files.filter(file => file && !file.busy && (typeof file.id === "string" || /^https?:\/\//i.test(file.url || ""))) : [],
        })),
      };
    });
    return { items, updatedAt: Number(saved?.updatedAt) || 0, collapsed: Array.isArray(saved?.collapsed) ? saved.collapsed : [] };
  }

  // Text has a synchronous backup; file bytes are committed to IndexedDB.
  function openDraftDatabase() {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("atelier-feedback", 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("drafts");
        database.createObjectStore("files", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Draft storage is busy"));
    });
    return databasePromise;
  }

  function readSavedDraft(database) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["drafts", "files"], "readonly");
      const draft = transaction.objectStore("drafts").get("current");
      const files = transaction.objectStore("files").getAll();
      transaction.oncomplete = () => resolve({ draft: draft.result, files: files.result });
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function draftSnapshot() {
    const draft = { version: 2, updatedAt: state.updatedAt || 0, collapsed: state.collapsed || [], items: {} };
    Object.entries(state.items).forEach(([id, item]) => {
      draft.items[id] = {
        ...item,
        notes: item.notes.map(note => ({
          ...note,
          files: note.files.map(file => ({
            id: file.id, name: file.name, type: file.type, size: file.size,
            ...(/^https?:\/\//i.test(file.url || "") ? { url: file.url } : {}),
          })),
        })),
      };
    });
    return draft;
  }

  function backupDraft(snapshot) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot));
      return true;
    } catch { return false; }
  }

  function writeSavedDraft(database, snapshot) {
    return new Promise((resolve, reject) => {
      let transaction;
      try { transaction = database.transaction(["drafts", "files"], "readwrite", { durability: "strict" }); }
      catch { transaction = database.transaction(["drafts", "files"], "readwrite"); }
      const activeFiles = new Set(Object.values(snapshot.items).flatMap(item => item.notes.flatMap(note => note.files.map(file => file.id).filter(Boolean))));
      const files = transaction.objectStore("files");
      transaction.objectStore("drafts").put(snapshot, "current");
      activeFiles.forEach(id => {
        if (!persistedFiles.has(id) && fileBlobs.has(id)) files.put({ id, blob: fileBlobs.get(id) });
      });
      persistedFiles.forEach(id => { if (!activeFiles.has(id)) files.delete(id); });
      transaction.oncomplete = () => { persistedFiles = activeFiles; resolve(); };
      transaction.onabort = () => reject(transaction.error || new Error("Draft save interrupted"));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function persistDraft() {
    clearTimeout(saveTimer);
    if (!restored) return Promise.resolve(false);
    const snapshot = draftSnapshot();
    const backedUp = backupDraft(snapshot);
    const hasAttachments = Object.values(snapshot.items).some(item => item.notes.some(note => note.files.some(file => file.id)));
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try {
        await writeSavedDraft(await openDraftDatabase(), snapshot);
        if (snapshot.updatedAt === state.updatedAt) $("#save-state").textContent = "Draft saved";
        return true;
      } catch {
        if (snapshot.updatedAt === state.updatedAt) $("#save-state").textContent = backedUp && !hasAttachments ? "Draft saved" : "Draft not fully saved";
        return backedUp && !hasAttachments;
      }
    });
    return saveQueue;
  }

  function saveDraft() {
    state.updatedAt = Math.max(Date.now(), (state.updatedAt || 0) + 1);
    backupDraft(draftSnapshot());
    clearTimeout(saveTimer);
    $("#save-state").textContent = "Saving…";
    saveTimer = setTimeout(persistDraft, 250);
    if (!requestedPersistence) {
      requestedPersistence = true;
      try { navigator.storage?.persist?.().catch(() => {}); }
      catch { /* Saving still works when a persistent-storage request is unavailable. */ }
    }
  }

  async function restoreDraft() {
    $("#save-state").textContent = "Restoring draft…";
    $("#send-feedback").disabled = true;
    let missingFiles = false;
    try {
      const saved = await readSavedDraft(await openDraftDatabase());
      if ((saved.draft?.updatedAt || 0) > (state.updatedAt || 0)) state = normalizeDraft(saved.draft);
      const stored = new Map(saved.files.map(file => [file.id, file.blob]));
      persistedFiles = new Set(stored.keys());
      Object.values(state.items).forEach(item => item.notes.forEach(note => {
        note.files = note.files.filter(file => {
          if (file.url) return true;
          const blob = stored.get(file.id);
          if (!blob) { missingFiles = true; return false; }
          fileBlobs.set(file.id, blob);
          file.url = URL.createObjectURL(blob);
          previewUrls.add(file.url);
          return true;
        });
      }));
    } catch {
      Object.values(state.items).forEach(item => item.notes.forEach(note => {
        note.files = note.files.filter(file => { if (file.url) return true; missingFiles = true; return false; });
      }));
    }
    restored = true;
    buildSections();
    $("#send-feedback").disabled = false;
    $("#save-state").textContent = missingFiles ? "Reattach missing files" : state.updatedAt ? "Draft restored" : "";
    document.documentElement.dataset.ready = "true";
  }

  function reviewed(item) {
    const current = state.items[item.id];
    if (item.kind === "request") return current.notes.some(note => note.text.trim() || note.files.length);
    if (item.kind === "rating") return current.rating != null;
    return current.status != null;
  }

  function updateProgress() {
    const done = REQUIRED_ITEMS.filter(reviewed).length;
    $("#done-n").textContent = done;
    $("#total-n").textContent = REQUIRED_ITEMS.length;
    $("#bar").style.width = `${Math.round(done / REQUIRED_ITEMS.length * 100)}%`;
    SECTIONS.forEach(section => {
      const required = section.items.filter(item => !item.optional);
      const count = `${required.filter(reviewed).length}/${required.length}`;
      document.querySelectorAll(`[data-count="${section.id}"]`).forEach(element => { element.textContent = count; });
    });
  }

  function updateDraft() {
    updateProgress();
    saveDraft();
  }

  function radioGroup(name, options, current, label, onPick, rating = false) {
    const group = createElement("div", { class: rating ? "rating" : "status", role: "radiogroup", "aria-label": label });
    group.dataset.val = current == null ? "" : String(current);
    options.forEach(([value, text]) => {
      const id = `${name}-${value}`;
      const input = createElement("input", { type: "radio", name, id, value });
      input.checked = current === value;
      const pick = selection => {
        group.dataset.val = selection == null ? "" : String(selection);
        onPick(selection);
        updateDraft();
      };
      input.addEventListener("click", () => {
        const selected = group.dataset.val === String(value);
        input.checked = !selected;
        pick(selected ? null : value);
      });
      input.addEventListener("change", () => {
        if (input.checked && group.dataset.val !== String(value)) pick(value);
      });
      group.append(createElement("label", { class: rating ? "pill" : `pill ${value}`, for: id }, [input, createElement("span", { text })]));
    });
    return group;
  }

  function buildItem(item) {
    const current = state.items[item.id];
    const box = createElement("div", { class: "item", id: `item-${item.id}` });
    box.append(createElement("div", { class: "item-top" }, [
      createElement("div", { class: "item-title", text: item.title }),
      createElement("div", { class: "item-desc", text: item.desc }),
    ]));
    if (item.kind === "rating") {
      const ratings = [1, 2, 3, 4, 5].map(value => [value, String(value)]);
      box.append(radioGroup(`r-${item.id}`, ratings, current.rating, "Overall rating", value => { current.rating = value; }, true));
      box.append(createElement("div", { class: "scale-ends", text: "1 = poor · 5 = excellent" }));
    } else if (item.kind !== "request") {
      box.append(radioGroup(`s-${item.id}`, STATUSES, current.status, item.title, value => { current.status = value; }));
    }
    const notes = createElement("div", { class: "notes" });
    current.notes.forEach(note => notes.append(buildNote(item, note)));
    box.append(notes, createElement("button", {
      type: "button", class: "add-note",
      onclick: () => {
        const note = { id: crypto.randomUUID(), text: "", files: [] };
        current.notes.push(note);
        const element = buildNote(item, note);
        notes.append(element);
        element.querySelector("textarea").focus();
        saveDraft();
      },
    }, [createElement("b", { text: "+" }), item.addLabel || (item.kind === "request" ? "Add a request" : "Add note")]));
    return box;
  }

  function releaseFile(file) {
    if (previewUrls.delete(file.url)) URL.revokeObjectURL(file.url);
    fileBlobs.delete(file.id);
  }

  function renderFiles(note, element) {
    const files = element.querySelector(".files");
    files.replaceChildren();
    note.files.forEach(file => {
      const thumbnail = createElement("div", { class: "file", title: file.name });
      if (file.type?.startsWith("image/")) thumbnail.append(createElement("img", { src: file.url, alt: file.name }));
      else if (file.type?.startsWith("video/")) {
        thumbnail.append(createElement("video", { src: file.url, muted: true, preload: "metadata" }));
        thumbnail.append(createElement("span", { class: "tag", text: "Video" }));
      } else thumbnail.append(createElement("span", { text: file.name }));
      thumbnail.append(createElement("button", {
        type: "button", class: "x", text: "×", "aria-label": `Remove ${file.name}`,
        onclick: () => {
          releaseFile(file);
          note.files = note.files.filter(existing => existing !== file);
          renderFiles(note, element);
          updateDraft();
        },
      }));
      files.append(thumbnail);
    });
  }

  function addFiles(note, element, files) {
    const errors = [];
    for (const file of files) {
      const type = file.type || FILE_TYPES[file.name.split(".").pop().toLowerCase()];
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name} is over 10 MB. Try a shorter clip or a smaller image.`);
      } else if (!SUPPORTED_TYPES.has(type)) {
        errors.push(`${file.name} isn't supported. Use a photo (PNG, JPG), a video (MP4, MOV) or a PDF.`);
      } else {
        const url = URL.createObjectURL(file);
        previewUrls.add(url);
        const id = crypto.randomUUID();
        fileBlobs.set(id, file);
        note.files.push({ id, name: file.name || "Pasted image", type, size: file.size, url });
      }
    }
    const error = element.querySelector(".ferr");
    error.textContent = errors.join(" ");
    error.hidden = errors.length === 0;
    renderFiles(note, element);
    updateDraft();
    void persistDraft();
  }

  function buildNote(item, note) {
    const element = createElement("div", { class: "note", "data-note": note.id });
    const textarea = createElement("textarea", {
      id: `n-${note.id}`, "aria-label": `Note for ${item.title}`,
      placeholder: item.placeholder || (item.kind === "request" ? "What should change? Be as specific as you can." : "What happened? When was the call, what did you say, what did the agent do?"),
      oninput: () => { note.text = textarea.value; updateDraft(); },
      onpaste: event => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) { event.preventDefault(); addFiles(note, element, files); }
      },
    });
    textarea.value = note.text;
    const bar = createElement("div", { class: "note-bar" }, [
      createElement("button", { type: "button", class: "tbtn", onclick: () => {
        pickTarget = { note, element };
        $("#picker").value = "";
        $("#picker").click();
      } }, [icon("clip"), "Attach"]),
      createElement("span", { class: "hint", text: "Photos, videos (MP4, MOV) or PDF, up to 10 MB each" }),
      createElement("span", { class: "spacer" }),
      createElement("button", { type: "button", class: "tbtn quiet", "aria-label": "Delete note", onclick: () => {
        note.files.forEach(releaseFile);
        state.items[item.id].notes = state.items[item.id].notes.filter(existing => existing !== note);
        if (pickTarget?.note === note) pickTarget = null;
        element.remove();
        updateDraft();
      } }, [icon("trash"), "Delete"]),
    ]);
    element.append(textarea, createElement("div", { class: "files" }), createElement("div", { class: "ferr", hidden: true, role: "alert" }), bar);
    renderFiles(note, element);
    return element;
  }

  function buildSections() {
    const sections = $("#sections");
    const jump = $("#jump");
    SECTIONS.forEach((section, index) => {
      const items = createElement("div", { class: "items", id: `items-${section.id}` });
      section.items.forEach(item => items.append(buildItem(item)));
      const wrapper = createElement("section", { class: "sec", id: `sec-${section.id}` });
      const toggle = createElement("button", {
        type: "button", class: "sec-head", "aria-expanded": "true", "aria-controls": items.id,
        onclick: () => {
          toggle.setAttribute("aria-expanded", String(!wrapper.classList.toggle("closed")));
          state.collapsed = [...document.querySelectorAll(".sec.closed")].map(section => section.id);
          saveDraft();
        },
      }, [
        createElement("span", { class: "num", text: String(index + 1) }),
        createElement("h2", { text: section.title }),
        createElement("span", { class: "tag", text: section.tag }),
        createElement("span", { class: "count", "data-count": section.id }),
        createElement("span", { class: "chev", "aria-hidden": "true" }),
      ]);
      if (state.collapsed.includes(wrapper.id)) {
        wrapper.classList.add("closed");
        toggle.setAttribute("aria-expanded", "false");
      }
      wrapper.append(toggle, items);
      sections.append(wrapper);
      jump.append(createElement("a", { href: `#${wrapper.id}`, onclick: () => {
        wrapper.classList.remove("closed");
        toggle.setAttribute("aria-expanded", "true");
        state.collapsed = state.collapsed.filter(id => id !== wrapper.id);
        saveDraft();
      } }, [section.title, createElement("span", { "data-count": section.id })]));
    });
    updateProgress();
  }

  function feedbackText(source = state) {
    const lines = ["L'Atelier Entrecôte – agent testing", ""];
    SECTIONS.forEach(section => {
      lines.push(section.title.toUpperCase());
      section.items.forEach(item => {
        const current = source.items[item.id];
        let line = `- ${item.title}`;
        if (item.kind === "rating") line += `: ${current.rating ?? "–"}/5`;
        else if (item.kind !== "request") line += `: ${STATUS_LABELS[current.status] || "–"}`;
        lines.push(line);
        current.notes.forEach(note => {
          if (note.text.trim()) lines.push(`    Note: ${note.text.trim()}`);
          note.files.forEach(file => lines.push(`    Attachment: ${file.name}`));
        });
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  $("#picker").addEventListener("change", () => {
    if (pickTarget?.element.isConnected) addFiles(pickTarget.note, pickTarget.element, [...$("#picker").files]);
    pickTarget = null;
  });
  function showSubmissionStatus(message, kind = "error") {
    const status = $("#submission-status");
    status.textContent = message;
    status.dataset.state = kind;
    status.hidden = false;
  }

  function showCopyFallback() {
    $("#fallback-text").value = feedbackText();
    $("#copied").textContent = "";
    $("#fallback").classList.remove("hidden");
  }

  function submissionError(code) {
    const messages = {
      form_not_found: "Sending is not available yet. Your draft is still saved.",
      form_inactive: "Sending is temporarily unavailable. Your draft is still saved.",
      domain_not_allowed: "This link is not ready to accept feedback yet. Your draft is still saved.",
      rate_limited: "Please wait a minute before sending again. Your draft is saved.",
      file_too_large: "An attachment is over 10 MB. Please use a smaller file and try again.",
      storage_quota_exceeded: "Attachments could not be sent right now. Your draft is saved. Please contact Parse AI.",
      uploads_unavailable: "Attachments could not be sent right now. Your draft is saved. Please try again later.",
      captcha_failed: "The security check could not be completed. Your draft is saved. Please contact Parse AI.",
    };
    return messages[code] || "The submission could not be confirmed. Your draft is saved. Check with Parse AI before sending again.";
  }

  async function sendFeedback() {
    const button = $("#send-feedback");
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "Sending…";
    $("#fallback").classList.add("hidden");
    let timeout;
    try {
      const saved = await persistDraft();
      if (!saved) throw new FeedbackError("Your draft could not be fully saved. Keep this page open and try again.");
      const endpoint = $("meta[name='feedback-endpoint']").content.trim();
      const match = /^https:\/\/formsubmit\.app\/f\/([a-zA-Z0-9_-]+)$/.exec(endpoint);
      if (!match) throw new FeedbackError("Sending has not been set up yet. Your draft is saved. You can copy your answers below.");
      const snapshot = draftSnapshot();
      const report = feedbackText(snapshot);
      if (report.length > 95000) throw new FeedbackError("Your feedback is too long to send at once. Please shorten the notes or share the copied answers with Parse AI.");
      if (!REQUIRED_ITEMS.some(reviewed) && !Object.values(snapshot.items).some(item => item.notes.some(note => note.text.trim() || note.files.length))) {
        throw new FeedbackError("Add a status, rating or note before sending your feedback.");
      }
      const attachments = Object.values(snapshot.items).flatMap(item => item.notes.flatMap(note => note.files)).map(file => ({ ...file, blob: fileBlobs.get(file.id) }));
      for (const file of attachments) {
        if (!file.blob) throw new FeedbackError(`Please remove and attach “${file.name}” again before sending.`);
        if (file.blob.size > MAX_FILE_SIZE) throw new FeedbackError(`“${file.name}” is over 10 MB. Please use a smaller file.`);
      }
      const data = new FormData();
      data.set("restaurant", "L'Atelier Entrecôte");
      data.set("feedback", report);
      data.set("reviewed_points", `${REQUIRED_ITEMS.filter(reviewed).length}/${REQUIRED_ITEMS.length}`);
      data.set("_subject", "L'Atelier Entrecôte – Agent testing feedback");
      data.set("_ts", String(openedAt));
      data.set("_gotcha", $("#website").value);
      if (attachments.length) {
        // The service's direct-upload API keeps large files out of the form request.
        uploadClientPromise ||= import("https://esm.sh/@vercel/blob@2.8.2/client?bundle");
        const { upload } = await uploadClientPromise;
        const files = [];
        for (const [index, file] of attachments.entries()) {
          showSubmissionStatus(`Uploading attachment ${index + 1} of ${attachments.length}…`, "pending");
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
          const result = await upload(`f/${match[1]}/${crypto.randomUUID()}-${safeName}`, file.blob, {
            access: "private",
            handleUploadUrl: "https://formsubmit.app/api/uploads",
            clientPayload: JSON.stringify({ formId: match[1] }),
          });
          files.push({ field: `attachment_${index + 1}`, url: result.url, filename: file.name });
        }
        data.set("_files", JSON.stringify(files));
      }
      showSubmissionStatus("Sending feedback…", "pending");
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 45000);
      const response = await fetch(endpoint, {
        method: "POST", headers: { Accept: "application/json" }, body: data, signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new FeedbackError(submissionError(result.error?.code));
      showSubmissionStatus("Feedback submitted. Thank you! Your draft is still saved on this device.", "success");
    } catch (error) {
      showSubmissionStatus(error instanceof FeedbackError ? error.message : submissionError());
      showCopyFallback();
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
      button.textContent = "Send feedback";
    }
  }

  $("#send-feedback").addEventListener("click", sendFeedback);
  $("#copy").addEventListener("click", async () => {
    const textarea = $("#fallback-text");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(textarea.value);
      $("#copied").textContent = "Copied";
    } catch {
      textarea.focus();
      textarea.select();
      $("#copied").textContent = "Text selected. Press Ctrl+C or ⌘C.";
    }
  });
  window.addEventListener("pagehide", event => {
    persistDraft();
    if (!event.persisted) {
      previewUrls.forEach(url => URL.revokeObjectURL(url));
      previewUrls.clear();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void persistDraft();
  });
  void restoreDraft();
})();
