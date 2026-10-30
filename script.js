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
  const MAX_TOTAL_FILE_SIZE = 15_000_000;
  const SEND_REQUEST_KEY = "atelier-feedback-formsubmit-send-v1";
  const CONTACT_FIELDS = { firstName: "first-name", lastName: "last-name", email: "email" };
  const uploadedFiles = new Map();
  let toolsPromise;
  let activeSend;
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
    const respondent = Object.fromEntries(Object.entries(CONTACT_FIELDS).map(([key]) => [key,
      typeof saved?.respondent?.[key] === "string" ? saved.respondent[key].slice(0, key === "email" ? 254 : 80) : "",
    ]));
    return { items, respondent, updatedAt: Number(saved?.updatedAt) || 0, collapsed: Array.isArray(saved?.collapsed) ? saved.collapsed : [] };
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
    const draft = { version: 3, respondent: { ...state.respondent }, updatedAt: state.updatedAt || 0, collapsed: state.collapsed || [], items: {} };
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
        await withDeadline(async () => writeSavedDraft(await openDraftDatabase(), snapshot), 10000);
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
      const saved = await withDeadline(async () => readSavedDraft(await openDraftDatabase()), 10000);
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
    Object.entries(CONTACT_FIELDS).forEach(([key, id]) => { $(`#${id}`).value = state.respondent[key]; });
    $("#contact-details").disabled = false;
    buildSections();
    $("#send-feedback").disabled = false;
    $("#download-report").disabled = false;
    $("#save-state").textContent = missingFiles ? "Reattach missing files" : state.updatedAt ? "Draft restored" : "";
    document.documentElement.dataset.ready = "true";
  }

  function reviewed(item, source = state) {
    const current = source.items[item.id];
    if (item.kind === "request") return current.notes.some(note => note.text.trim() || note.files.length);
    if (item.kind === "rating") return current.rating != null;
    return current.status != null;
  }

  function updateProgress() {
    const done = REQUIRED_ITEMS.filter(item => reviewed(item)).length;
    $("#done-n").textContent = done;
    $("#total-n").textContent = REQUIRED_ITEMS.length;
    $("#bar").style.width = `${Math.round(done / REQUIRED_ITEMS.length * 100)}%`;
    SECTIONS.forEach(section => {
      const required = section.items.filter(item => !item.optional);
      const count = `${required.filter(item => reviewed(item)).length}/${required.length}`;
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
    uploadedFiles.delete(file.id);
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
    let total = Object.values(state.items).flatMap(item => item.notes.flatMap(note => note.files)).reduce((sum, file) => sum + (file.size || 0), 0);
    let count = Object.values(state.items).flatMap(item => item.notes.flatMap(note => note.files)).length;
    for (const file of files) {
      const type = file.type || FILE_TYPES[file.name.split(".").pop().toLowerCase()];
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name} is over 10 MB. Try a shorter clip or a smaller image.`);
      } else if (total + file.size > MAX_TOTAL_FILE_SIZE) {
        errors.push(`${file.name} would exceed the 15 MB total. Remove a file or use a smaller version.`);
      } else if (count >= 20) {
        errors.push("You can attach up to 20 files to one response.");
      } else if (!SUPPORTED_TYPES.has(type)) {
        errors.push(`${file.name} isn't supported. Use a photo (PNG, JPG), a video (MP4, MOV) or a PDF.`);
      } else {
        const url = URL.createObjectURL(file);
        previewUrls.add(url);
        const id = crypto.randomUUID();
        fileBlobs.set(id, file);
        note.files.push({ id, name: file.name || "Pasted image", type, size: file.size, url });
        total += file.size;
        count += 1;
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
      createElement("span", { class: "hint", text: "Photos, videos (MP4, MOV) or PDF, 10 MB per file, 15 MB total" }),
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

  function sectionText(section, source) {
    return section.items.map(item => {
      const current = source.items[item.id];
      const answer = item.kind === "rating" ? (current.rating ? `${current.rating}/5` : "Not rated")
        : item.kind === "request" ? (reviewed(item, source) ? "Feedback provided" : "No requests")
        : STATUS_LABELS[current.status] || "Not reviewed";
      const lines = [`${item.title} — ${answer}`];
      current.notes.forEach(note => {
        if (note.text.trim()) lines.push(`Note: ${note.text.trim()}`);
        note.files.forEach(file => lines.push(`Attachment: ${file.name}`));
      });
      return lines.join("\n");
    }).join("\n\n");
  }

  function reviewSummary(source) {
    const done = REQUIRED_ITEMS.filter(item => reviewed(item, source)).length;
    const counts = STATUSES.map(([value, label]) => `${label}: ${ITEMS.filter(item => source.items[item.id].status === value).length}`);
    return `${done} of ${REQUIRED_ITEMS.length} points reviewed · Overall rating: ${source.items.general.rating ? `${source.items.general.rating}/5` : "Not rated"}\n${counts.join(" · ")}`;
  }

  function feedbackText(source = state) {
    const person = source.respondent;
    return ["L'Atelier Entrecôte — Agent testing feedback", "",
      `First name: ${person.firstName.trim()}`, `Last name: ${person.lastName.trim()}`, `Email: ${person.email.trim()}`, "",
      reviewSummary(source), "", ...SECTIONS.flatMap(section => [section.title.toUpperCase(), sectionText(section, source), ""]),
    ].join("\n");
  }

  function validateContact(showErrors = true) {
    let firstInvalid;
    Object.entries(CONTACT_FIELDS).forEach(([key, id]) => {
      const input = $(`#${id}`);
      const value = input.value.trim();
      const message = !value ? `Enter your ${key === "firstName" ? "first name" : key === "lastName" ? "last name" : "email address"}.`
        : key === "email" && input.validity.typeMismatch ? "Enter a valid email address, such as name@example.com."
        : input.validity.tooLong ? "Please use a shorter value." : "";
      if (showErrors || input.getAttribute("aria-invalid") === "true") {
        const error = $(`#${id}-error`);
        error.textContent = message;
        error.hidden = !message;
        input.setAttribute("aria-invalid", String(!!message));
      }
      if (message && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid && showErrors) firstInvalid.focus();
    return !firstInvalid;
  }

  Object.entries(CONTACT_FIELDS).forEach(([key, id]) => {
    const input = $(`#${id}`);
    input.addEventListener("input", () => {
      state.respondent[key] = input.value;
      validateContact(false);
      saveDraft();
    });
    input.addEventListener("blur", () => {
      if (input.value || input.getAttribute("aria-invalid") === "true") validateContact(false);
    });
  });

  // Every asynchronous step has a deadline, including local storage and upload setup.
  async function withDeadline(work, milliseconds, parentSignal) {
    if (parentSignal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let timer;
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => reject(new DOMException("Operation cancelled or timed out", "AbortError"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    parentSignal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(cancel, milliseconds);
    try {
      if (controller.signal.aborted) throw new DOMException("Operation cancelled", "AbortError");
      return await Promise.race([work(controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }

  function loadTools() {
    if (window.AtelierTools) return Promise.resolve(window.AtelierTools);
    if (!toolsPromise) toolsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/feedback-tools.js?v=20261030-2";
      let timer;
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        toolsPromise = null;
        reject(new FeedbackError("The report and upload tools could not load. Check your connection and reload this page. Your draft is saved."));
      };
      script.onload = () => {
        clearTimeout(timer);
        if (window.AtelierTools) resolve(window.AtelierTools);
        else fail();
      };
      script.onerror = fail;
      timer = setTimeout(fail, 15000);
      document.head.append(script);
    });
    return toolsPromise;
  }

  function reportModel(source, date) {
    return {
      person: { ...source.respondent }, date, summary: reviewSummary(source),
      sections: SECTIONS.map(section => ({ ...section, items: section.items.map(item => ({
        title: item.title,
        status: item.kind === "rating" ? (source.items[item.id].rating ? `${source.items[item.id].rating}/5` : "Not rated")
          : item.kind === "request" ? (reviewed(item, source) ? "Feedback provided" : "No requests")
          : STATUS_LABELS[source.items[item.id].status] || "Not reviewed",
        tone: source.items[item.id].status,
        notes: source.items[item.id].notes.map(note => ({ text: note.text.trim(), files: note.files.map(file => file.name) })),
      })) })),
    };
  }

  function makeReport(model, tools) {
    const pdf = new tools.jsPDF({ unit: "mm", format: "a4", compress: true });
    tools.installReportFonts(pdf);
    pdf.setProperties({ title: "Atelier — Agent testing feedback", author: `${model.person.firstName} ${model.person.lastName}`, creator: "Parse AI" });
    const left = 18, width = 174, bottom = 275;
    let y;
    let currentSection = "";
    const text = (value, x, top, size = 10, color = "#121216", bold = false) => {
      pdf.setFont("DMSans", bold ? "bold" : "normal");
      pdf.setFontSize(size);
      pdf.setTextColor(color);
      pdf.text(String(value), x, top);
    };
    const rule = top => { pdf.setDrawColor("#e2e2e8"); pdf.line(left, top, left + width, top); };
    const header = () => {
      text("</", left, 17, 17, "#c8175e", true);
      text("Parse AI", left + 9, 17, 17, "#121216", true);
      text("AGENT TESTING / FEEDBACK", 129, 17, 8, "#5f5f6b");
      rule(22);
      y = 33;
    };
    const ensure = height => {
      if (y + height > bottom) {
        pdf.addPage();
        header();
        if (currentSection) {
          text(`${currentSection} (continued)`, left, y, 9, "#5f5f6b");
          y += 9;
        }
      }
    };
    const paragraph = (value, { size = 10, color = "#121216", bold = false, indent = 0, gap = 2 } = {}) => {
      pdf.setFont("DMSans", bold ? "bold" : "normal");
      pdf.setFontSize(size);
      const lines = pdf.splitTextToSize(String(value), width - indent);
      for (const line of lines) {
        ensure(6);
        text(line, left + indent, y, size, color, bold);
        y += size * .45;
      }
      y += gap;
    };
    header();
    paragraph("L'Atelier Entrecôte", { size: 25, bold: true, gap: 1 });
    paragraph("Agent testing feedback", { size: 18, color: "#c8175e", bold: true, gap: 6 });
    paragraph(`${model.person.firstName.trim()} ${model.person.lastName.trim()}`, { size: 12, bold: true });
    paragraph(model.person.email.trim(), { color: "#5f5f6b" });
    paragraph(new Date(model.date).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" }), { size: 9, color: "#5f5f6b", gap: 5 });
    paragraph(model.summary, { size: 10, color: "#5f5f6b", gap: 7 });
    model.sections.forEach((section, index) => {
      currentSection = "";
      ensure(45);
      rule(y - 3);
      y += 5;
      paragraph(`${index + 1}. ${section.title}`, { size: 15, bold: true, gap: 5 });
      currentSection = section.title;
      section.items.forEach(item => {
        ensure(22);
        paragraph(item.title, { size: 11, bold: true, gap: 0 });
        const color = item.tone === "ok" ? "#1b7048" : item.tone === "mid" ? "#9a5a10" : item.tone === "bad" ? "#c8175e" : "#5f5f6b";
        paragraph(item.status, { size: 9, color, gap: 2 });
        item.notes.forEach(note => {
          if (note.text) paragraph(note.text, { indent: 3, gap: 2 });
          if (note.files.length) paragraph(`Attachments: ${note.files.join(", ")}`, { size: 9, color: "#5f5f6b", indent: 3 });
        });
        y += 4;
      });
      y += 4;
    });
    const pages = pdf.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
      pdf.setPage(page);
      rule(282);
      text("L'ATELIER ENTRECÔTE / PARSE AI", left, 288, 8, "#5f5f6b");
      text(`${page} / ${pages}`, 180, 288, 8, "#5f5f6b");
    }
    return pdf.output("blob");
  }

  function reportFilename(source) {
    const name = `${source.respondent.firstName}-${source.respondent.lastName}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 80);
    return `Atelier-feedback-${name || "report"}.pdf`;
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
    return ({
      form_not_found: "This form connection no longer exists. Please contact Parse AI.",
      form_inactive: "This form is temporarily paused. Please contact Parse AI.",
      domain_not_allowed: "This website address is not allowed in the FormSubmit settings yet.",
      rate_limited: "Please wait a minute before trying again.",
      file_too_large: "An attachment exceeds the service's 10 MB limit. Please use a smaller file.",
      payload_too_large: "The attachments are too large for this request. Please use smaller files.",
      storage_quota_exceeded: "The form's attachment storage is full. Please contact Parse AI.",
      uploads_unavailable: "The attachment service is temporarily unavailable. Please try again later.",
      captcha_failed: "Please contact Parse AI to check the form's captcha settings.",
    })[code] || "The service could not accept your feedback. Please try again later.";
  }

  async function readServiceResponse(response) {
    let result;
    try { result = await response.json(); }
    catch { throw new FeedbackError("The service returned an unexpected response. Please try again later."); }
    if (!response.ok || result.ok === false) throw new FeedbackError(submissionError(result.error?.code));
    return result;
  }

  function submissionFilename(file) {
    const original = file.name || "attachment";
    const dot = original.lastIndexOf(".");
    const ending = dot > 0 ? original.slice(dot + 1).toLowerCase() : "";
    const extension = Object.hasOwn(FILE_TYPES, ending) && FILE_TYPES[ending] === file.type ? ending
      : Object.keys(FILE_TYPES).find(key => FILE_TYPES[key] === file.type) || "bin";
    // Use ASCII names for compatibility with download headers, including macOS
    // screenshot names with a narrow space. Keep originals in the draft/report.
    const stem = (dot > 0 ? original.slice(0, dot) : original).normalize("NFKD")
      .replace(/\p{M}/gu, "").replace(/[^a-zA-Z0-9._ -]+/g, "-")
      .replace(/\s+/g, " ").replace(/^[ .-]+|[ .-]+$/g, "")
      .slice(0, 140).trim() || "attachment";
    return `${stem}.${extension}`;
  }

  async function sendRequestIdentity(endpoint, report, attachments) {
    const description = JSON.stringify({ endpoint, report, files: attachments.map(file => [file.id, submissionFilename(file), file.type, file.blob.size]) });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(description));
    const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    try {
      const earlier = JSON.parse(localStorage.getItem(SEND_REQUEST_KEY));
      if (earlier?.fingerprint === fingerprint) return earlier;
    } catch { /* Confirmed sends are remembered when local storage is available. */ }
    return { fingerprint, createdAt: Date.now(), sent: false };
  }

  async function uploadFile(file, formId, tools, signal, onProgress) {
    const previous = uploadedFiles.get(file.id);
    if (previous?.formId === formId && Date.now() - previous.at < 30 * 60 * 1000) return previous.reference;
    const filename = submissionFilename(file);
    const path = `f/${formId}/${crypto.randomUUID()}-${filename.replace(/ /g, "_")}`;
    // The service reports the store's actual access mode with its short-lived token.
    const permission = await withDeadline(async uploadSignal => {
      const response = await fetch("https://formsubmit.app/api/uploads", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: uploadSignal,
        body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname: path, clientPayload: JSON.stringify({ formId }), multipart: false } }),
      });
      return readServiceResponse(response);
    }, 20000, signal);
    if (typeof permission.clientToken !== "string" || !["private", "public"].includes(permission.access)) {
      throw new FeedbackError("The attachment service returned invalid upload settings. Please contact Parse AI.");
    }
    const result = await withDeadline(uploadSignal => tools.put(path, file.blob, {
      token: permission.clientToken, access: permission.access, contentType: file.type,
      abortSignal: uploadSignal, onUploadProgress: event => onProgress(event.percentage),
    }), 120000, signal);
    if (!/^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\//i.test(result.url || "")) {
      throw new FeedbackError("The attachment service returned an invalid file address.");
    }
    const reference = { field: file.field, url: result.url, filename };
    uploadedFiles.set(file.id, { formId, at: Date.now(), reference });
    return reference;
  }

  function submissionFields(snapshot) {
    const data = new FormData();
    data.set("First name", snapshot.respondent.firstName.trim());
    data.set("Last name", snapshot.respondent.lastName.trim());
    data.set("email", snapshot.respondent.email.trim());
    data.set("Restaurant", "L'Atelier Entrecôte");
    data.set("Review summary", reviewSummary(snapshot));
    SECTIONS.forEach((section, index) => data.set(`${index + 1}. ${section.title}`, sectionText(section, snapshot)));
    const name = `${snapshot.respondent.firstName.trim()} ${snapshot.respondent.lastName.trim()}`.replace(/\s+/g, " ");
    data.set("_subject", `Atelier feedback — ${name}`);
    data.set("_replyto", snapshot.respondent.email.trim());
    data.set("_ts", String(openedAt));
    data.set("_gotcha", $("#website").value);
    return data;
  }

  async function sendFeedback(event) {
    event?.preventDefault();
    const button = $("#send-feedback");
    if (button.disabled || activeSend) return;
    if (!validateContact()) {
      showSubmissionStatus("Please complete your first name, last name and email address.");
      return;
    }
    button.disabled = true;
    button.textContent = "Sending…";
    $("#download-report").disabled = true;
    $("#cancel-send").hidden = false;
    $("#fallback").classList.add("hidden");
    $("#send-progress").hidden = false;
    $("#send-progress").value = 0;
    activeSend = new AbortController();
    const signal = activeSend.signal;
    let submitted = false;
    let phase = "Preparing your feedback";
    showSubmissionStatus(`${phase}…`, "pending");
    try {
      if (!await withDeadline(() => persistDraft(), 11000, signal)) throw new FeedbackError("Your draft could not be fully saved. Keep this page open and try again.");
      const endpoint = $("meta[name='feedback-endpoint']").content.trim();
      const match = /^https:\/\/formsubmit\.app\/f\/([a-zA-Z0-9_-]+)$/.exec(endpoint);
      if (!match) throw new FeedbackError("Sending has not been set up yet. Please contact Parse AI.");
      const snapshot = draftSnapshot();
      const report = feedbackText(snapshot);
      if (report.length > 95000) throw new FeedbackError("Please shorten your notes before sending. You can copy the full answers below.");
      if (!ITEMS.some(item => reviewed(item, snapshot) || snapshot.items[item.id].notes.some(note => note.text.trim() || note.files.length))) {
        throw new FeedbackError("Add a status, rating or note before sending your feedback.");
      }
      const files = SECTIONS.flatMap(section => section.items.flatMap(item => snapshot.items[item.id].notes.flatMap(note => note.files.map(file => ({ ...file, field: `${item.title} attachment`, blob: fileBlobs.get(file.id) })))));
      if (files.length > 20) throw new FeedbackError("Please attach no more than 20 files to one response.");
      let total = 0;
      for (const file of files) {
        if (!file.blob) throw new FeedbackError(`Please remove and attach “${file.name}” again before sending.`);
        if (file.blob.size > MAX_FILE_SIZE) throw new FeedbackError(`“${file.name}” is over 10 MB. Please use a smaller file.`);
        total += file.blob.size;
      }
      if (total > MAX_TOTAL_FILE_SIZE) throw new FeedbackError("Attachments must total 15 MB or less. Please use smaller files.");
      const identity = await sendRequestIdentity(endpoint, report, files);
      if (identity.sent) {
        showSubmissionStatus("This version was already submitted. Edit your answers to send an update.", "success");
        return;
      }
      const tools = await withDeadline(loadTools, 16000, signal);
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const pdf = makeReport(reportModel(snapshot, identity.createdAt), tools);
      const reportFile = { id: `report-${identity.fingerprint}`, field: "Feedback report (PDF)", name: reportFilename(snapshot), type: "application/pdf", blob: pdf };
      const attachments = [reportFile, ...files];
      const data = submissionFields(snapshot);
      const size = attachments.reduce((bytes, file) => bytes + file.blob.size, 0);
      // Small submissions go straight to FormSubmit, without a separate storage upload.
      if (size <= 3_500_000) {
        attachments.forEach(file => data.append(file.field, file.blob, submissionFilename(file)));
      } else {
        const references = [];
        for (const [index, file] of attachments.entries()) {
          phase = `Uploading ${index + 1} of ${attachments.length}: ${file.name}`;
          showSubmissionStatus(`${phase}…`, "pending");
          references.push(await uploadFile(file, match[1], tools, signal, percentage => {
            $("#send-progress").value = (index + percentage / 100) / attachments.length * 85;
            showSubmissionStatus(`${phase} — ${Math.round(percentage)}%`, "pending");
          }));
          $("#send-progress").value = (index + 1) / attachments.length * 85;
        }
        data.set("_files", JSON.stringify(references));
      }
      try { localStorage.setItem(SEND_REQUEST_KEY, JSON.stringify(identity)); } catch { /* The draft still remains available. */ }
      phase = "Sending your feedback";
      showSubmissionStatus(`${phase}…`, "pending");
      $("#send-progress").value = 90;
      const result = await withDeadline(async sendSignal => {
        submitted = true;
        const response = await fetch(endpoint, { method: "POST", headers: { Accept: "application/json" }, body: data, signal: sendSignal });
        return readServiceResponse(response);
      }, 45000, signal);
      if (result.ok !== true) throw new FeedbackError("The service did not confirm your submission.");
      identity.sent = true;
      try { localStorage.setItem(SEND_REQUEST_KEY, JSON.stringify(identity)); } catch { /* Sending succeeded even if the local receipt could not be stored. */ }
      $("#send-progress").value = 100;
      showSubmissionStatus("Feedback submitted. Thank you! Your draft is still saved on this device.", "success");
    } catch (error) {
      let message = error instanceof FeedbackError ? error.message
        : signal.aborted ? "Sending was cancelled."
        : error.name === "AbortError" ? `${phase} took too long. Please check your connection.`
        : "The connection failed. Please check your internet connection.";
      message += submitted ? " Your draft is saved. Check FormSubmit or Hiba's inbox before retrying, because the service may have received it."
        : " No feedback was submitted. Your draft is still saved; you can try again.";
      showSubmissionStatus(message);
      showCopyFallback();
    } finally {
      activeSend = null;
      button.disabled = false;
      button.textContent = "Send feedback";
      $("#download-report").disabled = false;
      $("#cancel-send").hidden = true;
      $("#send-progress").hidden = true;
    }
  }

  $("#feedback-form").addEventListener("submit", sendFeedback);
  $("#cancel-send").addEventListener("click", () => activeSend?.abort());
  $("#download-report").addEventListener("click", async () => {
    if (!validateContact()) {
      showSubmissionStatus("Complete your details to include them in the report.");
      return;
    }
    const button = $("#download-report");
    button.disabled = true;
    try {
      const snapshot = draftSnapshot();
      const blob = makeReport(reportModel(snapshot, Date.now()), await loadTools());
      const url = URL.createObjectURL(blob);
      const link = createElement("a", { href: url, download: reportFilename(snapshot) });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      showSubmissionStatus("Report downloaded. It will also be included when you send your feedback.", "success");
    } catch (error) {
      showSubmissionStatus(error instanceof FeedbackError ? error.message : "The report could not be created. Your draft is saved.");
    } finally { button.disabled = false; }
  });

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
