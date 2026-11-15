/**
 * HZF & BIN Studio - Inspection Builder & Editor
 * Directly loads, edits, and saves .hzf, .bin, and PDF reports without HIP Desktop.
 * Full Saved Reports Library support.
 * Zero hardcoded data.
 */

(function () {
  'use strict';

  console.log("app.js build 2026-10-29T10:00:00-persist");

  const State = {
    authToken: localStorage.getItem('hzf_auth_token') || null,
    currentUser: null,
    isInspectionActive: false,
    activeReportId: null,
    fileName: "Untitled_Inspection.hzf",
    clientInfo: {},
    sections: [],
    activeSectionId: null,
    activePhotoTarget: null, // { secId, itemId, photoIdx }
    cachedPdfBlobUrl: null,
    pdfDirty: true,
    pdfIsGenerating: false,
    pdfDoc: null,
    pdfCurrentPage: 1,
    pdfTotalPages: 1,
    pdfFitMode: 'page',
    pdfZoom: 1.0,
    pdfCurrentScale: null,
    currentRenderTask: null,
    isDirty: false,
    activeTab: 'checklist'
  };

  // ==========================================================================
  // BULLETPROOF PERSISTENCE ENGINE (DUAL-TIER SYNCHRONOUS + ASYNC STORAGE)
  // Tier 1: Instant Synchronous SessionStorage (Structure, Findings, Notes, Status)
  // Tier 2: Dedicated IndexedDB Stores (High-Res Photos & Complete Backups)
  // Guarantees that refreshing (F5 / reload) STAYS on the active inspection!
  // ==========================================================================

  const IDB_NAME = 'hzf_studio_storage_v4';
  const IDB_VERSION = 1;
  let _idbInstance = null;

  function getSessionIdb() {
    if (_idbInstance) return Promise.resolve(_idbInstance);
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      try {
        const req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('photos')) {
            db.createObjectStore('photos');
          }
          if (!db.objectStoreNames.contains('full_session')) {
            db.createObjectStore('full_session');
          }
        };
        req.onsuccess = () => {
          _idbInstance = req.result;
          _idbInstance.onversionchange = () => {
            _idbInstance.close();
            _idbInstance = null;
          };
          resolve(_idbInstance);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function idbSavePhotos(photosMap) {
    const db = await getSessionIdb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('photos', 'readwrite');
        const store = tx.objectStore('photos');
        for (const [filename, dataUrl] of Object.entries(photosMap)) {
          if (dataUrl && dataUrl.startsWith('data:')) {
            store.put(dataUrl, filename);
          }
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function idbGetPhotos(filenames) {
    const db = await getSessionIdb();
    if (!db || !filenames || filenames.length === 0) return {};
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('photos', 'readonly');
        const store = tx.objectStore('photos');
        const map = {};
        let pending = filenames.length;
        if (pending === 0) return resolve(map);

        filenames.forEach(fn => {
          const req = store.get(fn);
          req.onsuccess = () => {
            if (req.result) map[fn] = req.result;
            pending--;
            if (pending <= 0) resolve(map);
          };
          req.onerror = () => {
            pending--;
            if (pending <= 0) resolve(map);
          };
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  async function idbSaveFullSession(payload) {
    const db = await getSessionIdb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('full_session', 'readwrite');
        const store = tx.objectStore('full_session');
        store.put(payload, 'active');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function idbGetFullSession() {
    const db = await getSessionIdb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('full_session', 'readonly');
        const store = tx.objectStore('full_session');
        const req = store.get('active');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
        tx.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  let _saveDebounceTimer = null;
  function debouncedSaveSession() {
    if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = setTimeout(() => {
      saveActiveSession();
    }, 200);
  }

  async function saveActiveSession() {
    if (!State.isInspectionActive || !State.sections || State.sections.length === 0) {
      return;
    }

    const activeTabEl = document.querySelector('.nav-tab.active');
    const currentTab = activeTabEl ? activeTabEl.getAttribute('data-tab') : (State.activeTab || 'checklist');

    // Build photo map and lightweight structure for instant sessionStorage persistence
    const photosMap = {};
    let totalPhotoBytes = 0;

    const lightweightSections = (State.sections || []).map(sec => ({
      id: sec.id,
      name: sec.name,
      desc: sec.desc || '',
      items: (sec.items || []).map(it => {
        const photoRefs = (it.photos || []).map(p => {
          if (p.filename && p.dataUrl) {
            photosMap[p.filename] = p.dataUrl;
            totalPhotoBytes += p.dataUrl.length;
          }
          return {
            filename: p.filename,
            caption: p.caption || '',
            // If total photo payload is small (< 2MB), keep dataUrl in sessionStorage too
            dataUrl: (totalPhotoBytes < 2000000) ? (p.dataUrl || '') : ''
          };
        });

        return {
          id: it.id,
          name: it.name,
          status: it.status,
          comments: it.comments || '',
          photos: photoRefs
        };
      })
    }));

    const sessionPayload = {
      isInspectionActive: true,
      fileName: State.fileName || "Untitled_Inspection.hzf",
      activeReportId: State.activeReportId || null,
      clientInfo: State.clientInfo || {},
      sections: lightweightSections,
      activeSectionId: State.activeSectionId || null,
      activeTab: currentTab,
      isDirty: !!State.isDirty,
      savedAt: Date.now()
    };

    // TIER 1: Save structure to sessionStorage (Synchronous, instant, never fails)
    try {
      sessionStorage.setItem('hzf_active_session_v4', JSON.stringify(sessionPayload));
      localStorage.setItem('hzf_active_session_flag', '1');
    } catch (e) {
      console.warn("sessionStorage save error:", e);
    }

    // TIER 2: Save full photos and full payload to IndexedDB (asynchronous)
    try {
      if (Object.keys(photosMap).length > 0) {
        idbSavePhotos(photosMap);
      }
      idbSaveFullSession({
        ...sessionPayload,
        sections: State.sections // full copy with all dataUrls
      });
    } catch (e) {
      console.warn("IndexedDB background save error:", e);
    }
  }

  async function getActiveSession() {
    // 1. Try instant Tier 1 sessionStorage first (0 ms!)
    let session = null;
    try {
      const raw = sessionStorage.getItem('hzf_active_session_v4');
      if (raw) {
        session = JSON.parse(raw);
      }
    } catch (e) {}

    // 2. Try Tier 2 IndexedDB if sessionStorage was empty
    if (!session) {
      try {
        session = await idbGetFullSession();
      } catch (e) {}
    }

    if (!session || !session.sections || session.sections.length === 0) {
      return null;
    }

    // 3. Hydrate photos from IndexedDB if dataUrls were omitted for size
    try {
      const missingPhotoFilenames = [];
      session.sections.forEach(s => {
        (s.items || []).forEach(it => {
          (it.photos || []).forEach(p => {
            if (p.filename && !p.dataUrl) {
              missingPhotoFilenames.push(p.filename);
            }
          });
        });
      });

      if (missingPhotoFilenames.length > 0) {
        const photoMap = await idbGetPhotos(missingPhotoFilenames);
        session.sections.forEach(s => {
          (s.items || []).forEach(it => {
            (it.photos || []).forEach(p => {
              if (p.filename && photoMap[p.filename]) {
                p.dataUrl = photoMap[p.filename];
              }
            });
          });
        });
      }
    } catch (e) {
      console.warn("Error hydrating photos from IndexedDB:", e);
    }

    return session;
  }

  async function clearActiveSession() {
    try {
      sessionStorage.removeItem('hzf_active_session_v4');
      localStorage.removeItem('hzf_active_session_flag');
    } catch (e) {}
    try {
      const db = await getSessionIdb();
      if (db) {
        const tx = db.transaction(['full_session', 'photos'], 'readwrite');
        tx.objectStore('full_session').clear();
        tx.objectStore('photos').clear();
      }
    } catch (e) {}
    State.isInspectionActive = false;
    State.activeReportId = null;
    State.fileName = "Untitled_Inspection.hzf";
    State.clientInfo = {};
    State.sections = [];
    State.activeSectionId = null;
    State.isDirty = false;
  }

  // Unsaved Changes Confirmation Modal Handlers
  function showConfirmLeaveModal() {
    const modal = document.getElementById('confirmLeaveModal');
    if (modal) {
      modal.style.display = 'flex';
      if (window.lucide) lucide.createIcons();
    } else {
      fallbackConfirmLeave();
    }
  }

  function hideConfirmLeaveModal() {
    const modal = document.getElementById('confirmLeaveModal');
    if (modal) {
      modal.style.display = 'none';
    }
  }

  async function fallbackConfirmLeave() {
    const shouldSave = window.confirm(
      "Do you want to save your inspection report before returning to the dashboard?\n\n" +
      "Click OK to Save & Return, or Cancel to choose whether to discard or stay."
    );
    if (shouldSave) {
      await saveActiveReport();
      await clearActiveSession();
      setWorkspaceActive(false, true);
    } else {
      const confirmDiscard = window.confirm(
        "Are you sure you want to leave without saving?\n\n" +
        "WARNING: Any unsaved inspection findings and photos will be gone!"
      );
      if (confirmDiscard) {
        await clearActiveSession();
        setWorkspaceActive(false, true);
      }
    }
  }

  let selectedPdfCoverPhoto = null; // Base64 dataUrl or null (for default)

  // Safe HTML/XML entity escaper
  function escapeXml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Dynamic API Base URL resolver for local dev & Vercel / Render deployment
  function apiUrl(endpoint) {
    let stored = localStorage.getItem('API_BASE_URL');
    if (stored && window.location.protocol === 'https:' && stored.startsWith('http://')) {
      stored = ''; // Ignore insecure localhost override when browsing on HTTPS
    }
    let base = (window.ENV && window.ENV.API_BASE_URL) || stored || '';
    if (!base && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '8000' && window.location.port !== '8001') {
      base = 'http://127.0.0.1:8000';
    }
    if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;
    return base ? `${base.replace(/\/+$/, '')}${endpoint}` : endpoint;
  }

  // HTML Escaping Helper to prevent XSS and undefined ReferenceErrors
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Toast Notification Helper
  function showToast(msg) {
    const t = document.getElementById('toastMessage');
    if (!t) return;
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  // Transparent Auth-intercepting Fetch Wrapper
  const _nativeFetch = window.fetch.bind(window);
  window.fetch = async function (resource, init = {}) {
    const url = (typeof resource === 'string') ? resource : (resource && resource.url ? resource.url : '');
    const isApi = (typeof url === 'string') && url.includes('/api/');
    if (isApi) {
      const token = State.authToken || localStorage.getItem('hzf_auth_token');
      if (token) {
        init = init || {};
        const headers = new Headers(init.headers || {});
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${token}`);
        }
        init.headers = headers;
      }
    }
    const response = await _nativeFetch(resource, init);
    if (response.status === 401 && isApi && !url.includes('/api/auth/login') && !url.includes('/api/auth/register') && !url.includes('/api/auth/verify-otp')) {
      if (State.authToken) {
        console.warn("Auth token invalid or expired. Logging out.");
        handleAuthLogout(false, "Your session has expired. Please log in again.");
      }
    }
    return response;
  };

  // ==========================================================================
  // AUTHENTICATION & ACCESS CONTROL
  // ==========================================================================
  let pendingAuthEmail = "";
  let adminUsersCache = [];

  function showAuthAlert(msg, type = "error") {
    const alertBox = document.getElementById("authAlert");
    if (!alertBox) return;
    if (!msg) {
      alertBox.style.display = "none";
      alertBox.textContent = "";
      alertBox.className = "auth-alert";
      return;
    }
    alertBox.textContent = msg;
    alertBox.className = `auth-alert ${type}`;
    alertBox.style.display = "block";
  }

  function setAuthTab(tab) {
    const tabLogin = document.getElementById("tabAuthLogin");
    const tabReg = document.getElementById("tabAuthRegister");
    const authTabsBar = document.getElementById("authTabsBar");
    const formLogin = document.getElementById("formAuthLogin");
    const formReg = document.getElementById("formAuthRegister");
    const formOtp = document.getElementById("formAuthOtp");
    const formForgot = document.getElementById("formAuthForgotPassword");
    const formReset = document.getElementById("formAuthResetPassword");

    showAuthAlert("");

    // Hide all forms initially
    if (formLogin) formLogin.style.display = "none";
    if (formReg) formReg.style.display = "none";
    if (formOtp) formOtp.style.display = "none";
    if (formForgot) formForgot.style.display = "none";
    if (formReset) formReset.style.display = "none";

    if (tab === "register") {
      if (authTabsBar) authTabsBar.style.display = "flex";
      tabLogin?.classList.remove("active");
      tabReg?.classList.add("active");
      if (formReg) formReg.style.display = "flex";
    } else if (tab === "otp") {
      if (authTabsBar) authTabsBar.style.display = "none";
      tabLogin?.classList.remove("active");
      tabReg?.classList.remove("active");
      if (formOtp) formOtp.style.display = "flex";
      const targetEl = document.getElementById("otpTargetEmail");
      if (targetEl) targetEl.textContent = pendingAuthEmail || "your email";
      const codeInput = document.getElementById("otpCodeInput");
      if (codeInput) {
        codeInput.value = "";
        setTimeout(() => codeInput.focus(), 60);
      }
    } else if (tab === "forgot") {
      if (authTabsBar) authTabsBar.style.display = "none";
      tabLogin?.classList.remove("active");
      tabReg?.classList.remove("active");
      if (formForgot) formForgot.style.display = "flex";
      const forgotEmailInput = document.getElementById("forgotEmail");
      if (forgotEmailInput) {
        if (pendingAuthEmail) forgotEmailInput.value = pendingAuthEmail;
        setTimeout(() => forgotEmailInput.focus(), 60);
      }
    } else if (tab === "reset-password") {
      if (authTabsBar) authTabsBar.style.display = "none";
      tabLogin?.classList.remove("active");
      tabReg?.classList.remove("active");
      if (formReset) formReset.style.display = "flex";
      const targetEl = document.getElementById("resetTargetEmail");
      if (targetEl) targetEl.textContent = pendingAuthEmail || "your email";
      const resetCodeInput = document.getElementById("resetOtpCode");
      if (resetCodeInput) {
        resetCodeInput.value = "";
        setTimeout(() => resetCodeInput.focus(), 60);
      }
    } else {
      // Default: login
      if (authTabsBar) authTabsBar.style.display = "flex";
      tabLogin?.classList.add("active");
      tabReg?.classList.remove("active");
      if (formLogin) formLogin.style.display = "flex";
    }

    if (window.lucide) {
      try { lucide.createIcons(); } catch (e) {}
    }
  }

  function showAuthScreen(tab = "login", alertMsg = "", alertType = "error") {
    document.body.classList.add("auth-mode-active");
    const authOverlay = document.getElementById("authScreen");
    if (authOverlay) authOverlay.style.display = "flex";
    setAuthTab(tab);
    if (alertMsg) showAuthAlert(alertMsg, alertType);
    if (window.lucide) lucide.createIcons();
  }

  function hideAuthScreen() {
    document.body.classList.remove("auth-mode-active");
    const authOverlay = document.getElementById("authScreen");
    if (authOverlay) authOverlay.style.display = "none";
    showAuthAlert("");
    if (window.lucide) lucide.createIcons();
  }

  function updateUserToolbar(user) {
    const userPill = document.getElementById("toolbarUserPill");
    const nameEl = document.getElementById("navUserName");
    const roleBadge = document.getElementById("navUserRoleBadge");
    const adminBtn = document.getElementById("btnNavAdmin");
    const btnOpenExisting = document.getElementById("btnOpenExisting");
    const btnStartNew = document.getElementById("btnStartNewInspection");
    const btnSavedReports = document.getElementById("btnOpenSavedReports");
    const brandTitle = document.getElementById("brandTitleText");
    const divider = document.getElementById("toolbarDividerNav");

    if (user) {
      const isAdmin = user.role === "admin";
      if (userPill) userPill.style.display = "flex";
      if (nameEl) nameEl.textContent = user.name || user.email.split("@")[0];
      if (roleBadge) {
        roleBadge.textContent = isAdmin ? "Admin" : "Inspector";
        roleBadge.className = `badge-role ${isAdmin ? "admin" : "user"}`;
      }

      if (isAdmin) {
        // For Admin: keep toolbar clean and dedicated - no inspector buttons, no redundant admin button
        if (adminBtn) adminBtn.style.display = "none";
        if (btnOpenExisting) btnOpenExisting.style.display = "none";
        if (btnStartNew) btnStartNew.style.display = "none";
        if (btnSavedReports) btnSavedReports.style.display = "none";
        if (divider) divider.style.display = "none";
        if (brandTitle) brandTitle.textContent = "HIP Studio Admin";
      } else {
        // For normal Inspectors: show standard inspection tools
        if (adminBtn) adminBtn.style.display = "none";
        if (btnOpenExisting) btnOpenExisting.style.display = "inline-flex";
        if (btnStartNew) btnStartNew.style.display = "inline-flex";
        if (btnSavedReports) btnSavedReports.style.display = "inline-flex";
        if (divider) divider.style.display = "block";
        if (brandTitle) brandTitle.textContent = "HIP Studio";
      }
    } else {
      if (userPill) userPill.style.display = "none";
      if (adminBtn) adminBtn.style.display = "none";
      if (brandTitle) brandTitle.textContent = "HIP Studio";
    }
    if (window.lucide) {
      try { lucide.createIcons(); } catch (e) {}
    }
  }

  async function checkAuthSession() {
    const token = State.authToken || localStorage.getItem("hzf_auth_token");
    if (!token) {
      showAuthScreen("login");
      return false;
    }
    try {
      const resp = await _nativeFetch(apiUrl("/api/auth/me"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.success && data.user) {
          State.currentUser = data.user;
          State.authToken = token;
          localStorage.setItem("hzf_user_info", JSON.stringify(data.user));
          updateUserToolbar(data.user);
          hideAuthScreen();
          if (data.user.role === 'admin') {
            openAdminPanel();
          } else {
            closeAdminPanel();
            refreshSavedReportsCount();
          }
          return true;
        }
      }
      handleAuthLogout(false, "Session invalid or expired. Please sign in.");
      return false;
    } catch (err) {
      console.warn("Auth check network warning:", err);
      const cached = localStorage.getItem("hzf_user_info");
      if (cached) {
        try {
          State.currentUser = JSON.parse(cached);
          updateUserToolbar(State.currentUser);
          hideAuthScreen();
          if (State.currentUser && State.currentUser.role === 'admin') {
            openAdminPanel();
          } else {
            closeAdminPanel();
            refreshSavedReportsCount();
          }
          return true;
        } catch (_) {}
      }
      showAuthScreen("login");
      return false;
    }
  }

  function handleAuthLogout(confirmWithUser = true, message = "") {
    if (confirmWithUser) {
      if (!confirm("Are you sure you want to log out of HZF Inspector Studio?")) return;
    }
    localStorage.removeItem("hzf_auth_token");
    localStorage.removeItem("hzf_user_info");
    State.authToken = null;
    State.currentUser = null;
    updateUserToolbar(null);
    closeAdminPanel();
    showAuthScreen("login", message || "You have been logged out.", "info");
    showToast(message || "Logged out successfully");
  }

  // ==========================================================================
  // ADMIN CONTROL CENTER
  // ==========================================================================
  function openAdminPanel() {
    if (!State.currentUser || State.currentUser.role !== "admin") {
      showToast("Access restricted: Administrator privileges required.");
      return;
    }
    const welcome = document.getElementById("welcomeScreen");
    const workspace = document.getElementById("activeWorkspace");
    const admin = document.getElementById("adminScreen");
    const btnAdminBack = document.getElementById("btnAdminBackToDash");
    const navTabs = document.getElementById("navCenterTabs");
    const exportGrp = document.getElementById("exportGroup");

    State.isInspectionActive = false;
    document.body.classList.remove('workspace-active');

    if (welcome) welcome.style.display = "none";
    if (workspace) workspace.style.display = "none";
    if (btnAdminBack) btnAdminBack.style.display = "none";
    if (navTabs) navTabs.style.display = "none";
    if (exportGrp) exportGrp.style.display = "none";
    if (admin) admin.style.display = "flex";

    loadAdminDashboard();
    if (window.lucide) lucide.createIcons();
  }

  function closeAdminPanel() {
    const admin = document.getElementById("adminScreen");
    if (admin) admin.style.display = "none";

    const welcome = document.getElementById("welcomeScreen");
    const workspace = document.getElementById("activeWorkspace");
    const btnAdminBack = document.getElementById("btnAdminBackToDash");
    const isAdmin = State.currentUser && State.currentUser.role === "admin";

    if (State.isInspectionActive) {
      if (workspace) workspace.style.display = "flex";
      if (welcome) welcome.style.display = "none";
      if (isAdmin && btnAdminBack) btnAdminBack.style.display = "inline-flex";
    } else {
      if (isAdmin) {
        if (admin) admin.style.display = "flex";
        if (welcome) welcome.style.display = "none";
      } else {
        if (welcome) welcome.style.display = "flex";
        if (workspace) workspace.style.display = "none";
      }
    }
  }

  async function loadAdminDashboard() {
    const tbody = document.getElementById("adminUsersTableBody");
    const token = State.authToken || localStorage.getItem("hzf_auth_token");
    try {
      const resp = await fetch(apiUrl("/api/admin/overview"), {
        headers: token ? { "Authorization": `Bearer ${token}` } : {}
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.success) {
          if (data.metrics) {
            const m = data.metrics;
            const uEl = document.getElementById("admMetricUsers");
            const vEl = document.getElementById("admMetricVerified");
            const rEl = document.getElementById("admMetricReports");
            const dEl = document.getElementById("admMetricDefects");
            if (uEl) uEl.textContent = m.totalUsers ?? 0;
            if (vEl) vEl.textContent = m.verifiedUsers ?? 0;
            if (rEl) rEl.textContent = m.totalReports ?? 0;
            if (dEl) dEl.textContent = m.totalDefects ?? 0;
          }
          if (Array.isArray(data.users)) {
            adminUsersCache = data.users;
            renderAdminUsersTable(adminUsersCache);
            return;
          }
        }
      }
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: #dc2626;">Unable to load inspector records. Please click Refresh.</td></tr>`;
      }
    } catch (err) {
      console.error("Admin dashboard fetch error:", err);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: #dc2626;">Error: ${escapeHtml(err.message)}</td></tr>`;
      }
      showToast("Error loading admin dashboard: " + err.message);
    }
  }

  let pendingDeleteUser = null;
  let pendingToggleUser = null;
  let wasAdminUserModalOpenForToggle = false;
  let wasAdminUserModalOpenForDelete = false;

  function openDeleteConfirmModal(user) {
    if (!user) return;
    pendingDeleteUser = user;
    const modal = document.getElementById("adminDeleteUserModal");
    if (!modal) return;

    // Immediately display the modal
    modal.style.display = "flex";

    const userModal = document.getElementById("adminUserModal");
    if (userModal && userModal.style.display !== "none") {
      wasAdminUserModalOpenForDelete = true;
      userModal.style.display = "none";
    } else {
      wasAdminUserModalOpenForDelete = false;
    }

    try {
      const avatarEl = document.getElementById("delConfirmAvatar");
      const nameEl = document.getElementById("delConfirmName");
      const emailEl = document.getElementById("delConfirmEmail");
      const repEl = document.getElementById("delConfirmReports");
      const defEl = document.getElementById("delConfirmDefects");

      const name = user.name || "Inspector";
      const initials = name.split(" ").filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "IN";
      if (avatarEl) avatarEl.textContent = initials;
      if (nameEl) nameEl.textContent = name;
      if (emailEl) emailEl.textContent = user.email || "—";
      if (repEl) repEl.textContent = user.reportsCount ?? user.reports_count ?? 0;
      if (defEl) defEl.textContent = user.totalDefects ?? user.total_defects ?? 0;

      if (window.lucide) {
        try { lucide.createIcons(); } catch (e) {}
      }
    } catch (err) {
      console.error("Error setting delete modal data:", err);
    }
  }

  function hideDeleteConfirmModal() {
    pendingDeleteUser = null;
    const modal = document.getElementById("adminDeleteUserModal");
    if (modal) modal.style.display = "none";
    if (wasAdminUserModalOpenForDelete) {
      const userModal = document.getElementById("adminUserModal");
      if (userModal) userModal.style.display = "flex";
      wasAdminUserModalOpenForDelete = false;
    }
  }

  function openToggleStatusModal(user) {
    if (!user) return;
    pendingToggleUser = user;
    const modal = document.getElementById("adminToggleStatusModal");
    if (!modal) return;

    // Immediately display the modal
    modal.style.display = "flex";

    const userModal = document.getElementById("adminUserModal");
    if (userModal && userModal.style.display !== "none") {
      wasAdminUserModalOpenForToggle = true;
      userModal.style.display = "none";
    } else {
      wasAdminUserModalOpenForToggle = false;
    }

    try {
      const isActive = (user.isActive !== undefined) ? !!user.isActive : (user.is_active !== undefined ? !!user.is_active : true);
      const header = document.getElementById("toggleModalHeader");
      const iconBox = document.getElementById("toggleModalIconBox");
      const title = document.getElementById("toggleModalTitle");
      const subtitle = document.getElementById("toggleModalSubtitle");
      const prompt = document.getElementById("toggleModalPrompt");
      const note = document.getElementById("toggleModalNote");
      const avatar = document.getElementById("toggleConfirmAvatar");
      const name = document.getElementById("toggleConfirmName");
      const email = document.getElementById("toggleConfirmEmail");
      const reports = document.getElementById("toggleConfirmReports");
      const defects = document.getElementById("toggleConfirmDefects");
      const confirmBtn = document.getElementById("btnConfirmToggleStatus");

      const uName = user.name || "Inspector";
      const initials = uName.split(" ").filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "IN";
      if (avatar) avatar.textContent = initials;
      if (name) name.textContent = uName;
      if (email) email.textContent = user.email || "—";
      if (reports) reports.textContent = user.reportsCount ?? user.reports_count ?? 0;
      if (defects) defects.textContent = user.totalDefects ?? user.total_defects ?? 0;

      if (isActive) {
        // Prompt to DEACTIVATE
        if (header) { header.style.background = "#fffbeb"; header.style.borderBottomColor = "#fef3c7"; }
        if (iconBox) {
          iconBox.style.background = "#fef3c7";
          iconBox.style.color = "#d97706";
          iconBox.innerHTML = `<i data-lucide="user-x" style="width: 18px; height: 18px;"></i>`;
        }
        if (title) { title.textContent = "Deactivate Inspector Account"; title.style.color = "#92400e"; }
        if (subtitle) { subtitle.textContent = "Blocks login access while preserving all records & reports"; subtitle.style.color = "#b45309"; }
        if (prompt) prompt.textContent = `Are you sure you want to deactivate "${uName}"? The inspector will not be able to log in, but all existing reports, clients, photos, and defect records will remain completely preserved and visible to the admin.`;
        if (note) {
          note.style.background = "#f0fdf4";
          note.style.borderLeftColor = "#16a34a";
          note.style.color = "#166534";
          note.innerHTML = `<strong>Data Safe:</strong> All past inspection reports and defect logs remain 100% saved and accessible in the system.`;
        }
        if (confirmBtn) {
          confirmBtn.style.background = "#d97706";
          confirmBtn.style.borderColor = "#b45309";
          confirmBtn.innerHTML = `<i data-lucide="user-x" style="width: 14px; height: 14px;"></i> <span id="btnConfirmToggleStatusText">Deactivate Account</span>`;
        }
      } else {
        // Prompt to ACTIVATE
        if (header) { header.style.background = "#ecfdf5"; header.style.borderBottomColor = "#a7f3d0"; }
        if (iconBox) {
          iconBox.style.background = "#d1fae5";
          iconBox.style.color = "#059669";
          iconBox.innerHTML = `<i data-lucide="user-check" style="width: 18px; height: 18px;"></i>`;
        }
        if (title) { title.textContent = "Activate Inspector Account"; title.style.color = "#065f46"; }
        if (subtitle) { subtitle.textContent = "Restores inspector login access"; subtitle.style.color = "#047857"; }
        if (prompt) prompt.textContent = `Are you sure you want to activate "${uName}"? The inspector will be able to log in to their account again.`;
        if (note) {
          note.style.background = "#eff6ff";
          note.style.borderLeftColor = "#2563eb";
          note.style.color = "#1e40af";
          note.innerHTML = `<strong>Access Restored:</strong> The inspector will be able to sign in immediately and resume creating inspection reports.`;
        }
        if (confirmBtn) {
          confirmBtn.style.background = "#059669";
          confirmBtn.style.borderColor = "#047857";
          confirmBtn.innerHTML = `<i data-lucide="user-check" style="width: 14px; height: 14px;"></i> <span id="btnConfirmToggleStatusText">Activate Account</span>`;
        }
      }

      if (window.lucide) {
        try { lucide.createIcons(); } catch (e) {}
      }
    } catch (err) {
      console.error("Error setting toggle modal content:", err);
    }
  }

  function hideToggleStatusModal() {
    const modal = document.getElementById("adminToggleStatusModal");
    if (modal) modal.style.display = "none";
    if (wasAdminUserModalOpenForToggle) {
      const userModal = document.getElementById("adminUserModal");
      if (userModal) userModal.style.display = "flex";
      wasAdminUserModalOpenForToggle = false;
    }
    pendingToggleUser = null;
  }

  function renderAdminUsersTable(users) {
    const tbody = document.getElementById("adminUsersTableBody");
    if (!tbody) return;

    if (!users || users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2.5rem; color: #64748b;">No inspector accounts match your search.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const isActive = (u.isActive !== undefined) ? !!u.isActive : (u.is_active !== undefined ? !!u.is_active : true);
      const isVerified = (u.isVerified !== undefined) ? !!u.isVerified : !!u.is_verified;
      
      let statusBadge = "";
      if (!isActive) {
        statusBadge = `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; border-radius: 12px; font-size: 11px; font-weight: 600;" title="Login disabled — all reports preserved"><i data-lucide="ban" style="width:10px;height:10px;"></i> Deactivated</span>`;
      } else if (isVerified) {
        statusBadge = `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; border-radius: 12px; font-size: 11px; font-weight: 600;"><i data-lucide="check" style="width:10px;height:10px;"></i> Verified</span>`;
      } else {
        statusBadge = `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #fffbeb; color: #d97706; border: 1px solid #fde68a; border-radius: 12px; font-size: 11px; font-weight: 600;"><i data-lucide="clock" style="width:10px;height:10px;"></i> Pending OTP</span>`;
      }

      const regDate = u.createdAt || u.created_at ? new Date(u.createdAt || u.created_at).toLocaleDateString() : "—";
      const lastActive = u.lastLogin || u.last_login ? new Date(u.lastLogin || u.last_login).toLocaleDateString() : "Never";
      const repCount = u.reportsCount ?? u.reports_count ?? 0;
      const defectCount = u.totalDefects ?? u.total_defects ?? 0;
      const isAdmin = u.role === 'admin';

      return `
        <tr class="admin-user-row" data-user-id="${u.id}" style="border-bottom: 1px solid #f1f5f9; background: ${isActive ? '#ffffff' : '#fafafa'}; opacity: ${isActive ? '1' : '0.88'}; cursor: pointer;" title="Click anywhere on row to view full inspector profile & reports">
          <td style="padding: 12px 14px;">
            <div style="font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 7px;">
              <i data-lucide="${isAdmin ? 'shield' : (isActive ? 'user' : 'user-x')}" style="width: 14px; height: 14px; color: ${isAdmin ? '#dc2626' : (isActive ? '#2563eb' : '#94a3b8')};"></i>
              <span>${escapeHtml(u.name || 'Inspector')}</span>
              ${isAdmin ? '<span style="font-size: 9px; padding: 1px 5px; background: #fee2e2; color: #dc2626; border-radius: 3px; font-weight: 700;">ADMIN</span>' : ''}
              ${!isActive ? '<span style="font-size: 9px; padding: 1px 5px; background: #fee2e2; color: #dc2626; border-radius: 3px; font-weight: 700;">DEACTIVATED</span>' : ''}
            </div>
          </td>
          <td style="padding: 12px 14px; font-family: Consolas, monospace; font-size: 11.5px; color: #334155;">${escapeHtml(u.email || '—')}</td>
          <td style="padding: 12px 14px; color: #475569;">${escapeHtml(u.phone || '—')}</td>
          <td style="padding: 12px 14px; color: #475569;">${escapeHtml(u.organization || '—')}</td>
          <td style="padding: 12px 14px;">${statusBadge}</td>
          <td style="padding: 12px 14px; text-align: center;"><strong style="color: #0284c7;">${repCount}</strong></td>
          <td style="padding: 12px 14px; text-align: center;"><span style="color: #ea580c; font-weight: 600;">${defectCount}</span></td>
          <td style="padding: 12px 14px; color: #64748b; font-size: 11px;">${regDate}</td>
          <td style="padding: 12px 14px; color: #64748b; font-size: 11px;">${lastActive}</td>
          <td style="padding: 12px 14px; text-align: center; white-space: nowrap;">
            <div style="display: inline-flex; align-items: center; gap: 6px;">
              <button class="hip-btn btn-sm btn-admin-view-user" data-user-id="${u.id}" style="padding: 4px 10px; font-size: 11px; background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; border-radius: 4px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="View all reports by this inspector">
                <i data-lucide="folder-open" style="width: 12px; height: 12px;"></i>
                <span>Reports (${repCount})</span>
              </button>
              ${!isAdmin ? `
              <button class="hip-btn btn-sm btn-admin-toggle-user" data-user-id="${u.id}" data-user-name="${escapeHtml(u.name || 'Inspector')}" data-user-email="${escapeHtml(u.email || '')}" data-user-active="${isActive ? 'true' : 'false'}" data-user-reports="${repCount}" data-user-defects="${defectCount}" style="padding: 4px 8px; font-size: 11px; ${isActive ? 'color: #b45309; border: 1px solid #fcd34d; background: #fffbeb;' : 'color: #059669; border: 1px solid #a7f3d0; background: #ecfdf5;'} border-radius: 4px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="${isActive ? 'Deactivate account (blocks login while keeping all reports and records safe)' : 'Activate account (restores login access)'}">
                <i data-lucide="${isActive ? 'user-x' : 'user-check'}" style="width: 12px; height: 12px;"></i>
                <span>${isActive ? 'Deactivate' : 'Activate'}</span>
              </button>
              <button class="hip-btn btn-sm btn-admin-del-user" data-user-id="${u.id}" data-user-email="${escapeHtml(u.email || '')}" data-user-name="${escapeHtml(u.name || 'Inspector')}" data-user-reports="${repCount}" data-user-defects="${defectCount}" style="padding: 4px 7px; color: #dc2626; border: 1px solid #fca5a5; background: #fff1f2; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center;" title="Permanently delete this inspector account and data">
                <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
              </button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join("");

    if (window.lucide) {
      try { lucide.createIcons(); } catch (e) {}
    }

    // Row Click: Clicking anywhere on the row opens the detailed inspector profile & reports
    tbody.querySelectorAll(".admin-user-row").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("a")) return;
        const uid = row.getAttribute("data-user-id");
        if (uid) openAdminUserModal(uid);
      });
    });

    tbody.querySelectorAll(".btn-admin-view-user").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const uid = btn.getAttribute("data-user-id");
        if (uid) openAdminUserModal(uid);
      });
    });

    tbody.querySelectorAll(".btn-admin-toggle-user").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const uid = btn.getAttribute("data-user-id");
        let user = adminUsersCache.find(u => String(u.id) === String(uid));
        if (!user) {
          user = {
            id: uid,
            name: btn.getAttribute("data-user-name") || "Inspector",
            email: btn.getAttribute("data-user-email") || "—",
            isActive: btn.getAttribute("data-user-active") !== "false",
            is_active: btn.getAttribute("data-user-active") !== "false",
            reportsCount: parseInt(btn.getAttribute("data-user-reports") || "0", 10),
            totalDefects: parseInt(btn.getAttribute("data-user-defects") || "0", 10),
          };
        }
        openToggleStatusModal(user);
      });
    });

    tbody.querySelectorAll(".btn-admin-del-user").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const uid = btn.getAttribute("data-user-id");
        let user = adminUsersCache.find(u => String(u.id) === String(uid));
        if (!user) {
          user = {
            id: uid,
            name: btn.getAttribute("data-user-name") || "Inspector",
            email: btn.getAttribute("data-user-email") || "—",
            reportsCount: parseInt(btn.getAttribute("data-user-reports") || "0", 10),
            totalDefects: parseInt(btn.getAttribute("data-user-defects") || "0", 10),
          };
        }
        openDeleteConfirmModal(user);
      });
    });
  }

  async function openAdminUserModal(userId) {
    const modal = document.getElementById("adminUserModal");
    if (!modal) return;

    const user = adminUsersCache.find(u => String(u.id) === String(userId)) || {};

    const avatarEl = document.getElementById("admSummaryAvatar");
    const nameEl = document.getElementById("admSummaryName");
    const emailEl = document.getElementById("admSummaryEmail");
    const phoneEl = document.getElementById("admSummaryPhone");
    const orgEl = document.getElementById("admSummaryOrg");
    const roleEl = document.getElementById("admSummaryRole");
    const statusPill = document.getElementById("admSummaryStatusPill");
    const idEl = document.getElementById("admSummaryId");
    const createdEl = document.getElementById("admSummaryCreated");
    const lastLoginEl = document.getElementById("admSummaryLastLogin");
    const titleEl = document.getElementById("adminModalUserTitle");
    const countEl = document.getElementById("admUserReportsCount");

    // Stat summary chips
    const statRepEl = document.getElementById("admStatRepCount");
    const statItemEl = document.getElementById("admStatItemCount");
    const statDefectEl = document.getElementById("admStatDefectCount");
    const statHazardEl = document.getElementById("admStatHazardCount");
    const statPhotoEl = document.getElementById("admStatPhotoCount");

    const name = user.name || "Inspector";
    const initials = name.split(" ").filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "IN";
    if (avatarEl) avatarEl.textContent = initials;
    if (titleEl) titleEl.textContent = `Inspector: ${name} — Full Profile`;
    if (nameEl) nameEl.textContent = name;
    if (emailEl) emailEl.textContent = user.email || "—";
    if (phoneEl) phoneEl.textContent = user.phone || "—";
    if (orgEl) orgEl.textContent = user.organization || "—";
    
    const uid = user.id || userId || "";
    if (idEl) {
      idEl.textContent = uid ? (uid.length > 18 ? uid.slice(0, 16) + "..." : uid) : "—";
      idEl.title = uid;
    }

    const isVerified = (user.isVerified !== undefined) ? !!user.isVerified : !!user.is_verified;
    const isActive = (user.isActive !== undefined) ? !!user.isActive : (user.is_active !== undefined ? !!user.is_active : true);

    if (statusPill) {
      statusPill.innerHTML = isVerified
        ? `<i data-lucide="check" style="width:10px;height:10px;"></i> Verified`
        : `<i data-lucide="clock" style="width:10px;height:10px;"></i> Pending OTP`;
      statusPill.style.background = isVerified ? "#ecfdf5" : "#fffbeb";
      statusPill.style.color = isVerified ? "#059669" : "#d97706";
      statusPill.style.borderColor = isVerified ? "#a7f3d0" : "#fde68a";
    }

    const activeBadge = document.getElementById("admSummaryActiveBadge");
    if (activeBadge) {
      activeBadge.innerHTML = isActive
        ? `<i data-lucide="check-circle-2" style="width:10px;height:10px;"></i> Active`
        : `<i data-lucide="ban" style="width:10px;height:10px;"></i> Deactivated`;
      activeBadge.style.background = isActive ? "#ecfdf5" : "#fef2f2";
      activeBadge.style.color = isActive ? "#059669" : "#dc2626";
      activeBadge.style.borderColor = isActive ? "#a7f3d0" : "#fecaca";
    }

    const toggleBtn = document.getElementById("btnModalToggleActive");
    function updateToggleBtnState(u) {
      if (!toggleBtn) return;
      if (u.role === 'admin') {
        toggleBtn.style.display = "none";
        return;
      }
      toggleBtn.style.display = "inline-flex";
      const uActive = (u.isActive !== undefined) ? !!u.isActive : (u.is_active !== undefined ? !!u.is_active : true);
      if (uActive) {
        toggleBtn.style.background = "#fffbeb";
        toggleBtn.style.color = "#b45309";
        toggleBtn.style.border = "1px solid #fcd34d";
        toggleBtn.innerHTML = `<i data-lucide="user-x" style="width: 14px; height: 14px;"></i> <span id="btnModalToggleActiveText">Deactivate Account</span>`;
      } else {
        toggleBtn.style.background = "#ecfdf5";
        toggleBtn.style.color = "#059669";
        toggleBtn.style.border = "1px solid #a7f3d0";
        toggleBtn.innerHTML = `<i data-lucide="user-check" style="width: 14px; height: 14px;"></i> <span id="btnModalToggleActiveText">Activate Account</span>`;
      }
      toggleBtn.onclick = () => {
        openToggleStatusModal(u);
      };
      if (window.lucide) {
        try { lucide.createIcons(); } catch (e) {}
      }
    }

    updateToggleBtnState(user);

    if (roleEl) {
      roleEl.textContent = (user.role || "user").toUpperCase();
      roleEl.className = `badge-role ${user.role === 'admin' ? 'admin' : 'user'}`;
    }

    const createdVal = user.createdAt || user.created_at;
    if (createdEl) createdEl.textContent = createdVal ? new Date(createdVal).toLocaleString() : "—";
    const lastVal = user.lastLogin || user.last_login;
    if (lastLoginEl) lastLoginEl.textContent = lastVal ? new Date(lastVal).toLocaleString() : "Active recently";

    const repCount = user.reportsCount ?? user.reports_count ?? 0;
    if (countEl) countEl.textContent = repCount;
    if (statRepEl) statRepEl.textContent = repCount;
    if (statItemEl) statItemEl.textContent = user.totalItems ?? user.total_items ?? (repCount > 0 ? "..." : 0);
    if (statDefectEl) statDefectEl.textContent = user.totalDefects ?? user.total_defects ?? (repCount > 0 ? "..." : 0);
    if (statHazardEl) statHazardEl.textContent = user.totalHazards ?? user.total_hazards ?? (repCount > 0 ? "..." : 0);
    if (statPhotoEl) statPhotoEl.textContent = user.totalPhotos ?? user.total_photos ?? (repCount > 0 ? "..." : 0);

    const tbody = document.getElementById("adminUserReportsBody");
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 1.5rem; color: #64748b;"><span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span> Loading user inspection reports...</td></tr>`;
    }

    modal.style.display = "flex";
    if (window.lucide) {
      try { lucide.createIcons(); } catch (e) {}
    }

    try {
      const token = State.authToken || localStorage.getItem("hzf_auth_token");
      const resp = await fetch(apiUrl(`/api/admin/users/${userId}/reports`), {
        headers: token ? { "Authorization": `Bearer ${token}` } : {}
      });
      if (resp.ok) {
        const json = await resp.json();
        const fullUser = Object.assign({}, user, json.user || {});
        // Update user in cache if present
        const cacheIdx = adminUsersCache.findIndex(u => String(u.id) === String(userId));
        if (cacheIdx >= 0) {
          adminUsersCache[cacheIdx] = Object.assign({}, adminUsersCache[cacheIdx], fullUser);
        }

        if (idEl && fullUser.id) {
          idEl.textContent = fullUser.id.length > 18 ? fullUser.id.slice(0, 16) + "..." : fullUser.id;
          idEl.title = fullUser.id;
        }
        if (lastLoginEl && fullUser.lastLogin) {
          lastLoginEl.textContent = new Date(fullUser.lastLogin).toLocaleString();
        }

        const uActive = (fullUser.isActive !== undefined) ? !!fullUser.isActive : (fullUser.is_active !== undefined ? !!fullUser.is_active : true);
        if (activeBadge) {
          activeBadge.innerHTML = uActive
            ? `<i data-lucide="check-circle-2" style="width:10px;height:10px;"></i> Active`
            : `<i data-lucide="ban" style="width:10px;height:10px;"></i> Deactivated`;
          activeBadge.style.background = uActive ? "#ecfdf5" : "#fef2f2";
          activeBadge.style.color = uActive ? "#059669" : "#dc2626";
          activeBadge.style.borderColor = uActive ? "#a7f3d0" : "#fecaca";
        }

        updateToggleBtnState(fullUser);

        const repList = (json.success && Array.isArray(json.reports)) ? json.reports : [];
        renderAdminUserReportsTable(repList, fullUser);
      } else {
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 1.5rem; color: #dc2626;">Failed to load reports.</td></tr>`;
      }
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 1.5rem; color: #dc2626;">Error: ${err.message}</td></tr>`;
    }

    if (window.lucide) lucide.createIcons();
  }

  function renderAdminUserReportsTable(reports, user) {
    const tbody = document.getElementById("adminUserReportsBody");
    const countEl = document.getElementById("admUserReportsCount");
    const statRepEl = document.getElementById("admStatRepCount");
    const statItemEl = document.getElementById("admStatItemCount");
    const statDefectEl = document.getElementById("admStatDefectCount");
    const statHazardEl = document.getElementById("admStatHazardCount");
    const statPhotoEl = document.getElementById("admStatPhotoCount");
    if (!tbody) return;

    const repList = Array.isArray(reports) ? reports : [];
    if (countEl) countEl.textContent = repList.length;

    // Unconditionally compute live aggregates from the inspector's reports
    let sumItems = 0, sumDefects = 0, sumHazards = 0, sumPhotos = 0;
    repList.forEach(r => {
      const stats = r.stats || {};
      sumItems += Number(r.totalItems ?? stats.item_count ?? 0) || 0;
      sumDefects += Number(r.defects ?? stats.defect_count ?? 0) || 0;
      sumHazards += Number(r.hazards ?? stats.hazard_count ?? 0) || 0;
      sumPhotos += Number(r.photoCount ?? stats.photo_count ?? 0) || 0;
    });

    if (statRepEl) statRepEl.textContent = repList.length;
    if (statItemEl) statItemEl.textContent = sumItems;
    if (statDefectEl) statDefectEl.textContent = sumDefects;
    if (statHazardEl) statHazardEl.textContent = sumHazards;
    if (statPhotoEl) statPhotoEl.textContent = sumPhotos;

    if (repList.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 1.5rem; color: #64748b;">No inspection reports found for this user.</td></tr>`;
      return;
    }

    tbody.innerHTML = repList.map(r => {
      const d = r.data || {};
      const client = d.clientInfo || {};
      const clientName = r.clientName || client.clientName || "—";
      const address = r.address || client.address || "—";
      const stats = r.stats || {};
      const itemsCount = r.totalItems ?? stats.item_count ?? 0;
      const defectsCount = r.defects ?? stats.defect_count ?? 0;
      const hazardsCount = r.hazards ?? stats.hazard_count ?? 0;
      const photosCount = r.photoCount ?? stats.photo_count ?? 0;
      const dateStr = r.savedAt || r.saved_at || r.inspectionDate || r.date || "—";

      return `
        <tr style="border-bottom: 1px solid #f1f5f9; background: #ffffff;">
          <td style="padding: 10px 12px;">
            <div style="font-weight: 600; color: #0f172a; display: flex; align-items: center; gap: 6px;">
              <i data-lucide="file-text" style="width: 14px; height: 14px; color: #7c3aed;"></i>
              <span>${escapeHtml(r.fileName || 'Inspection_Report.hzf')}</span>
            </div>
          </td>
          <td style="padding: 10px 12px; font-weight: 500; color: #1e293b;">${escapeHtml(clientName)}</td>
          <td style="padding: 10px 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #475569;" title="${escapeHtml(address)}">${escapeHtml(address)}</td>
          <td style="padding: 10px 12px; color: #64748b; font-size: 11px;">${dateStr}</td>
          <td style="padding: 10px 12px; text-align: center;">${itemsCount}</td>
          <td style="padding: 10px 12px; text-align: center;"><span style="color: #ea580c; font-weight: 600;">${defectsCount}</span></td>
          <td style="padding: 10px 12px; text-align: center;"><span style="color: #dc2626; font-weight: 600;">${hazardsCount}</span></td>
          <td style="padding: 10px 12px; text-align: center;">${photosCount}</td>
          <td style="padding: 10px 12px; text-align: center; white-space: nowrap;">
            <div style="display: flex; gap: 5px; justify-content: center; align-items: center;">
              <button class="hip-btn btn-sm btn-adm-view-pdf" data-rep-id="${r.id}" style="background: #0284c7; color: #ffffff; border: 1px solid #0284c7; font-weight: 600; padding: 4px 10px; border-radius: 4px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;" title="Open & view full visual inspection report in browser viewer">
                <i data-lucide="eye" style="width: 13px; height: 13px;"></i>
                <span>Open</span>
              </button>
              <button class="hip-btn btn-sm btn-adm-open-studio" data-rep-id="${r.id}" style="background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; font-weight: 600; padding: 4px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;" title="Open and edit inspection inside studio workspace">
                <i data-lucide="edit-3" style="width: 12px; height: 12px;"></i>
                <span>Studio</span>
              </button>
              <button class="hip-btn btn-sm btn-adm-dl-pdf" data-rep-id="${r.id}" style="background: #ffffff; color: #dc2626; border: 1px solid #fca5a5; padding: 4px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;" title="Download PDF report file">
                <i data-lucide="download" style="width: 12px; height: 12px;"></i>
                <span>PDF</span>
              </button>
              <button class="hip-btn btn-sm btn-adm-dl-hzf" data-rep-id="${r.id}" style="background: #ffffff; color: #2563eb; border: 1px solid #bfdbfe; padding: 4px 8px; border-radius: 4px; cursor: pointer;" title="Download .hzf archive">
                <span>.hzf</span>
              </button>
              <button class="hip-btn btn-sm btn-adm-dl-bin" data-rep-id="${r.id}" style="background: #ffffff; color: #059669; border: 1px solid #a7f3d0; padding: 4px 8px; border-radius: 4px; cursor: pointer;" title="Download .bin archive">
                <span>.bin</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    if (window.lucide) lucide.createIcons();

    // Open & View PDF Report directly without navigating away from Admin Panel
    tbody.querySelectorAll(".btn-adm-view-pdf").forEach(btn => {
      btn.addEventListener("click", async () => {
        const rid = btn.getAttribute("data-rep-id");
        if (!rid) return;
        const oldHtml = btn.innerHTML;
        btn.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;"></span> Opening...`;
        btn.disabled = true;

        const viewerTab = window.open('about:blank', '_blank');
        if (viewerTab) {
          viewerTab.document.write(`
            <html><head><title>Opening Inspection Report...</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; color: #1e293b; }
              .box { text-align: center; background: #ffffff; padding: 32px 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
              .spinner { width: 28px; height: 28px; border: 3px solid #e2e8f0; border-top-color: #0284c7; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px auto; }
              @keyframes spin { to { transform: rotate(360deg); } }
            </style>
            </head><body><div class="box"><div class="spinner"></div><h3 style="margin:0 0 8px 0;">Compiling Inspection Report...</h3><p style="margin:0;font-size:13px;color:#64748b;">Rendering high-resolution vector layout, defect summaries, and inspection photos...</p></div></body></html>
          `);
        }

        try {
          const resp = await fetch(apiUrl(`/api/reports/${rid}`));
          if (!resp.ok) throw new Error("Could not load report data");
          const json = await resp.json();
          if (!json.success || !json.data) throw new Error("Invalid report response");

          const cleanBase = (json.data.fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
          const pdfFilename = `${cleanBase}_Report.pdf`;

          const respPdf = await fetch(apiUrl('/api/export-pdf'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: rid,
              fileName: pdfFilename,
              clientInfo: json.data.clientInfo || {},
              sections: json.data.sections || [],
              coverPhoto: null,
              inspectorInfo: {
                companyName: json.data.clientInfo?.companyName || "N G Home Inspection Services",
                inspectorName: json.data.clientInfo?.inspectorName || "Nitin Gujarathi",
                phone: json.data.clientInfo?.inspectorPhone || "00919890002635",
                email: json.data.clientInfo?.inspectorEmail || "niting@macj.in",
                officeAddress: json.data.clientInfo?.inspectorAddress || "4_4 Yugaymangal complex, Kothrud, Pune, Maharashtra 411038"
              }
            })
          });

          if (!respPdf.ok) throw new Error("PDF generation service error");
          const blob = await respPdf.blob();
          const pdfUrl = URL.createObjectURL(blob);

          if (viewerTab) {
            viewerTab.location.href = pdfUrl;
          } else {
            window.open(pdfUrl, '_blank');
          }
          showToast("Report opened in viewer tab.");
        } catch (err) {
          if (viewerTab) viewerTab.close();
          showToast("Error opening report: " + err.message, "error");
        } finally {
          btn.innerHTML = oldHtml;
          btn.disabled = false;
          if (window.lucide) lucide.createIcons();
        }
      });
    });

    // Optional: Open in Studio workspace with a prominent Back button
    tbody.querySelectorAll(".btn-adm-open-studio").forEach(btn => {
      btn.addEventListener("click", () => {
        const rid = btn.getAttribute("data-rep-id");
        if (rid) {
          const modal = document.getElementById("adminUserModal");
          if (modal) modal.style.display = "none";
          SavedReports.openSaved(rid);
        }
      });
    });

    tbody.querySelectorAll(".btn-adm-dl-pdf").forEach(btn => {
      btn.addEventListener("click", () => {
        const rid = btn.getAttribute("data-rep-id");
        if (rid) SavedReports.downloadSaved(rid, "pdf");
      });
    });

    tbody.querySelectorAll(".btn-adm-dl-hzf").forEach(btn => {
      btn.addEventListener("click", () => {
        const rid = btn.getAttribute("data-rep-id");
        if (rid) SavedReports.downloadSaved(rid, "hzf");
      });
    });

    tbody.querySelectorAll(".btn-adm-dl-bin").forEach(btn => {
      btn.addEventListener("click", () => {
        const rid = btn.getAttribute("data-rep-id");
        if (rid) SavedReports.downloadSaved(rid, "bin");
      });
    });
  }

  // Switch between Welcome Hub and Active Inspection Workspace
  function setWorkspaceActive(active, pushState = true) {
    const welcome = document.getElementById('welcomeScreen');
    const workspace = document.getElementById('activeWorkspace');
    const admin = document.getElementById('adminScreen');
    const navTabs = document.getElementById('navCenterTabs');
    const exportGrp = document.getElementById('exportGroup');
    const navBack = document.getElementById('btnNavBack');
    const btnAdminBack = document.getElementById('btnAdminBackToDash');
    const isAdmin = State.currentUser && State.currentUser.role === 'admin';

    if (isAdmin) {
      State.isInspectionActive = active;
      document.body.classList.toggle('workspace-active', active);
      if (welcome) welcome.style.display = 'none';

      if (active) {
        if (admin) admin.style.display = 'none';
        if (workspace) workspace.style.display = 'flex';
        if (navTabs) navTabs.style.display = 'flex';
        if (exportGrp) exportGrp.style.display = 'flex';
        if (btnAdminBack) btnAdminBack.style.display = 'inline-flex';
        if (navBack) navBack.style.display = 'none';
        renderAll();
      } else {
        if (admin) admin.style.display = 'flex';
        if (workspace) workspace.style.display = 'none';
        if (navTabs) navTabs.style.display = 'none';
        if (exportGrp) exportGrp.style.display = 'none';
        if (btnAdminBack) btnAdminBack.style.display = 'none';
        if (navBack) navBack.style.display = 'none';
        loadAdminDashboard();
      }
      return;
    }

    State.isInspectionActive = active;
    document.body.classList.toggle('workspace-active', active);

    if (admin) admin.style.display = 'none';
    if (btnAdminBack) btnAdminBack.style.display = 'none';
    if (welcome) welcome.style.display = active ? 'none' : 'flex';
    if (workspace) workspace.style.display = active ? 'flex' : 'none';
    if (navTabs) navTabs.style.display = active ? 'flex' : 'none';
    if (exportGrp) exportGrp.style.display = active ? 'flex' : 'none';
    if (navBack) navBack.style.display = active ? 'inline-flex' : 'none';

    // Auto-dismiss open export menus and mobile drawer on state changes
    const exportContainer = document.getElementById('exportMenuContainer');
    if (exportContainer) exportContainer.classList.remove('open');
    const mobileDrawer = document.getElementById('mobileNavDrawer');
    if (mobileDrawer) mobileDrawer.style.display = 'none';
    const mobileBackdrop = document.getElementById('mobileNavBackdrop');
    if (mobileBackdrop) mobileBackdrop.style.display = 'none';

    if (active) {
      if (pushState) {
        try {
          if (window.location.hash !== '#workspace') {
            history.pushState({ view: 'workspace' }, '', '#workspace');
          }
        } catch (e) {}
      }
      renderAll();
    } else {
      if (pushState && window.location.hash === '#workspace') {
        try {
          history.pushState({ view: 'home' }, '', window.location.pathname + window.location.search);
        } catch (e) {}
      }
    }
    refreshSavedReportsCount();
  }

  // Back Navigation Helper to return to Welcome Dashboard with Unsaved Confirmation
  function goBackHome() {
    if (State.isInspectionActive && State.sections && State.sections.length > 0) {
      showConfirmLeaveModal();
    } else {
      clearActiveSession();
      setWorkspaceActive(false, true);
    }
  }

  // Fetch count of saved reports from backend
  async function refreshSavedReportsCount() {
    try {
      const resp = await fetch(apiUrl("/api/reports"));
      if (resp.ok) {
        const json = await resp.json();
        if (json.success && json.reports) {
          const badge = document.getElementById('savedReportsCountBadge');
          if (badge) badge.textContent = json.reports.length;
          const dBadge = document.getElementById('drawerSavedReportsCountBadge');
          if (dBadge) dBadge.textContent = json.reports.length;
          const wBadge = document.getElementById('welcomeSavedCount');
          if (wBadge) wBadge.textContent = json.reports.length;
        }
      }
    } catch (e) {
      // offline
    }
  }

  // Fetch and display saved reports list in modal
  async function loadSavedReportsModal() {
    const listEl = document.getElementById('savedReportsList');
    if (!listEl) return;
    listEl.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">Loading saved reports...</div>';

    try {
      const resp = await fetch(apiUrl("/api/reports"));
      if (resp.ok) {
        const json = await resp.json();
        if (json.success && json.reports && json.reports.length > 0) {
          listEl.innerHTML = '';
          json.reports.forEach(rep => {
            const item = document.createElement('div');
            item.className = 'saved-report-item';
            item.innerHTML = `
              <div class="saved-report-info">
                <div class="saved-report-header-line">
                  <i data-lucide="home" class="saved-report-icon"></i>
                  <h4>${escapeXml(rep.address || 'Untitled Property')}</h4>
                </div>
                <p>Client: <strong>${escapeXml(rep.clientName || 'N/A')}</strong> • Saved: <strong>${escapeXml(rep.savedAt || rep.inspectionDate || 'Recently')}</strong></p>
                <div class="saved-report-badges">
                  ${rep.hazards > 0 ? `<span class="mini-badge badge-hazard"><i data-lucide="alert-octagon"></i>${rep.hazards} Hazards</span>` : ''}
                  ${rep.defects > 0 ? `<span class="mini-badge badge-defect"><i data-lucide="alert-triangle"></i>${rep.defects} Defects</span>` : ''}
                  <span class="mini-badge badge-neutral"><i data-lucide="check-circle-2"></i>${rep.totalItems} Items</span>
                  <span class="mini-badge badge-neutral"><i data-lucide="camera"></i>${rep.photoCount} Photos</span>
                </div>
              </div>
              <div class="saved-report-actions">
                <button class="btn btn-primary btn-sm btn-action-open" onclick="window.App.openSaved('${rep.id}')" title="Open and edit report in studio">
                  <i data-lucide="folder-open"></i>
                  <span>Open</span>
                </button>
                <button class="btn btn-outline btn-sm btn-action-pdf" onclick="window.App.downloadSaved('${rep.id}', 'pdf')" title="Download exact visual PDF report">
                  <i data-lucide="file-text" style="color: #dc2626;"></i>
                  <span>PDF</span>
                </button>
                <button class="btn btn-outline btn-sm" onclick="window.App.downloadSaved('${rep.id}', 'hzf')" title="Download .hzf archive">
                  <i data-lucide="package" style="color: #2563eb;"></i>
                  <span>.hzf</span>
                </button>
                <button class="btn btn-outline btn-sm" onclick="window.App.downloadSaved('${rep.id}', 'bin')" title="Download .bin container">
                  <i data-lucide="file-archive" style="color: #059669;"></i>
                  <span>.bin</span>
                </button>
                <button class="btn btn-icon btn-danger-ghost btn-sm" onclick="window.App.deleteSaved('${rep.id}')" title="Delete Report">
                  <i data-lucide="trash-2"></i>
                </button>
              </div>
            `;
            listEl.appendChild(item);
          });
          if (window.lucide) lucide.createIcons();
          return;
        }
      }
    } catch (e) {
      console.log("Could not load reports:", e);
    }

    listEl.innerHTML = `
      <div class="empty-saved-state">
        <i data-lucide="archive"></i>
        <h4 style="color: var(--text-main); font-weight: 700;">No Saved Reports Yet</h4>
        <p>When you edit or build an inspection, click <strong>Save</strong> to store it here for future editing or download.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
  }

  // Save current active inspection to backend library
  async function saveActiveReport() {
    showToast("Saving report to library...");

    // Sync latest form values
    syncFormToState();

    try {
      const resp = await fetch(apiUrl("/api/reports/save"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: State.fileName,
          clientInfo: State.clientInfo,
          sections: State.sections
        })
      });

      if (resp.ok) {
        const json = await resp.json();
        if (json.success) {
          State.activeReportId = json.id;
          State.isDirty = false;
          saveActiveSession();
          refreshSavedReportsCount();
          showToast("Inspection saved to library!");
          return true;
        }
      }
    } catch (e) {
      showToast("Backend offline: saving locally in browser storage.");
    }

    // Local storage fallback
    try {
      localStorage.setItem(`hzf_report_${Date.now()}`, JSON.stringify({
        fileName: State.fileName,
        clientInfo: State.clientInfo,
        sections: State.sections
      }));
      State.isDirty = false;
      saveActiveSession();
      showToast("Saved to browser storage!");
      return true;
    } catch (err) {
      showToast("Error saving: " + err.message);
      return false;
    }
  }

  // Start Blank Inspection Template (Zero Hardcoded Data)
  async function startBlankInspection() {
    if (State.isInspectionActive && State.sections && State.sections.length > 0 && State.isDirty) {
      const confirmNew = window.confirm(
        "You have unsaved changes in your current inspection! Do you want to start a new blank inspection?\n\n" +
        "Click OK to proceed (unsaved changes will be replaced), or Cancel to stay."
      );
      if (!confirmNew) return;
    }

    showToast("Initializing blank inspection...");

    // Try backend template
    try {
      const resp = await fetch(apiUrl("/api/template"));
      if (resp.ok) {
        const json = await resp.json();
        if (json.success && json.data) {
          State.activeReportId = null;
          State.fileName = "New_Inspection.hzf";
          State.clientInfo = json.data.clientInfo || {};
          State.sections = json.data.sections || [];
          State.activeSectionId = State.sections[0] ? State.sections[0].id : null;
          State.isDirty = true;
          setWorkspaceActive(true);
          saveActiveSession();
          showToast("Blank inspection ready. Add property details and mobile photos.");
          return;
        }
      }
    } catch (e) {
      console.log("Using standard built-in blank template...");
    }

    // Standard blank structure fallback
    State.activeReportId = null;
    State.fileName = "New_Inspection.hzf";
    State.clientInfo = {
      clientName: "",
      clientPhone: "",
      clientEmail: "",
      inspectionAddress: "",
      inspectorName: "",
      inspectorLicense: "",
      inspectionCompany: "",
      inspectionDate: new Date().toISOString().split('T')[0],
      inspectionTime: "",
      propertyType: "",
      yearBuilt: "",
      squareFootage: "",
      weather: ""
    };
    State.sections = [
      {
        id: "sec_roof",
        name: "Roofing System",
        desc: "Roof coverings, flashings, valleys, and gutters",
        items: [
          { id: "it_roof_1", name: "Roof Covering Materials", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_roof_2", name: "Flashings & Valleys", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_roof_3", name: "Gutters & Downspouts", status: "Satisfactory", comments: "", photos: [] }
        ]
      },
      {
        id: "sec_exterior",
        name: "Exterior & Grounds",
        desc: "Siding, trim, walkways, grading, and drainage",
        items: [
          { id: "it_ext_1", name: "Siding, Flashing & Trim", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_ext_2", name: "Walkways & Driveway", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_ext_3", name: "Grading & Drainage", status: "Satisfactory", comments: "", photos: [] }
        ]
      },
      {
        id: "sec_electrical",
        name: "Electrical System",
        desc: "Service entrance, main panel, branch wiring, GFCI/AFCI",
        items: [
          { id: "it_elec_1", name: "Main Service Panel & Wiring", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_elec_2", name: "GFCI & AFCI Protection", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_elec_3", name: "Branch Circuits & Outlets", status: "Satisfactory", comments: "", photos: [] }
        ]
      },
      {
        id: "sec_plumbing",
        name: "Plumbing System",
        desc: "Water supply, water heater, drain/waste/vent lines",
        items: [
          { id: "it_plumb_1", name: "Main Water Supply & Pressure", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_plumb_2", name: "Water Heater Equipment", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_plumb_3", name: "Drain, Waste & Vent Lines", status: "Satisfactory", comments: "", photos: [] }
        ]
      },
      {
        id: "sec_hvac",
        name: "Heating & Cooling (HVAC)",
        desc: "Air conditioning equipment and heating furnace",
        items: [
          { id: "it_hvac_1", name: "Air Conditioning Equipment", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_hvac_2", name: "Heating Equipment & Furnace", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_hvac_3", name: "Ducts & Air Distribution", status: "Satisfactory", comments: "", photos: [] }
        ]
      },
      {
        id: "sec_interior",
        name: "Interior & Rooms",
        desc: "Ceilings, walls, floors, doors, and windows",
        items: [
          { id: "it_int_1", name: "Ceilings & Walls", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_int_2", name: "Doors & Windows", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_int_3", name: "Floors & Stairs", status: "Satisfactory", comments: "", photos: [] }
        ]
      },
      {
        id: "sec_attic",
        name: "Attic & Insulation",
        desc: "Roof framing structure and insulation levels",
        items: [
          { id: "it_attic_1", name: "Attic Insulation Depth", status: "Satisfactory", comments: "", photos: [] },
          { id: "it_attic_2", name: "Roof Structure & Trusses", status: "Satisfactory", comments: "", photos: [] }
        ]
      },
      {
        id: "sec_foundation",
        name: "Foundation & Structure",
        desc: "Foundation perimeter, slab, or crawlspace",
        items: [
          { id: "it_found_1", name: "Foundation Perimeter & Slab", status: "Satisfactory", comments: "", photos: [] }
        ]
      }
    ];
    State.activeSectionId = State.sections[0].id;
    State.isDirty = true;
    setWorkspaceActive(true);
    saveActiveSession();
  }

  // Helper to sanitize XML strings from Java XMLDecoder (HIP) and generic inspection archives
  function sanitizeXmlString(str) {
    if (!str) return '';
    let text = str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    text = text.replace(/<string>([\s\S]*?)<\/string>/g, (m, inner) => {
      inner = inner.replace(/&(?!(?:amp|lt|gt|apos|quot);)/g, '&amp;');
      inner = inner.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<string>${inner}</string>`;
    });
    text = text.replace(/&(?!(?:amp|lt|gt|apos|quot);)/g, '&amp;');
    text = text.replace(/<<([^>]+)>>/g, '&lt;&lt;$1&gt;&gt;');
    return text;
  }

  // ==============================================================================
  // CLIENT-SIDE HOME INSPECTOR PRO (.BIN & .HZF) PARSER (Robust DOM Level 1)
  // ==============================================================================
  function parseHipFormatJs(xmlFiles, imageMap) {
    const clientInfo = {};
    const sections = [];

    // Helper: get text of child tag
    function getChildTags(parent, tagName) {
      const results = [];
      const children = parent.children || parent.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c.nodeName && c.nodeName.toLowerCase() === tagName.toLowerCase()) {
          results.push(c);
        }
      }
      return results;
    }

    // 1. ClientInfo.xml
    const clientXmlStr = xmlFiles['clientinfo.xml'] || xmlFiles['ClientInfo.xml'] || '';
    if (clientXmlStr) {
      try {
        const dp = new DOMParser();
        const doc = dp.parseFromString(sanitizeXmlString(clientXmlStr), "text/xml");
        const rawProps = {};
        const voids = doc.getElementsByTagName('void');
        for (let i = 0; i < voids.length; i++) {
          const v = voids[i];
          const prop = v.getAttribute ? v.getAttribute('property') : null;
          if (prop) {
            rawProps[prop] = v.textContent.trim();
          }
        }

        const addrParts = [rawProps.address, rawProps.address2, rawProps.city, rawProps.state, rawProps.zip].filter(Boolean);
        if (addrParts.length > 0) clientInfo.inspectionAddress = addrParts.join(', ');

        const nameParts = [rawProps.firstName, rawProps.lastName].filter(Boolean);
        if (nameParts.length > 0) clientInfo.clientName = nameParts.join(' ');

        if (rawProps.phone) clientInfo.clientPhone = rawProps.phone;
        if (rawProps.email) clientInfo.clientEmail = rawProps.email;
        if (rawProps.inspectorName) clientInfo.inspectorName = rawProps.inspectorName;
        if (rawProps.company) clientInfo.inspectionCompany = rawProps.company;
        if (rawProps.weather) clientInfo.weather = rawProps.weather;
        if (rawProps.otherInfo) clientInfo.propertyType = rawProps.otherInfo;

        if (rawProps.inspectionDate) {
          if (/^\d+$/.test(rawProps.inspectionDate)) {
            try {
              clientInfo.inspectionDate = new Date(parseInt(rawProps.inspectionDate, 10)).toISOString().split('T')[0];
            } catch(e) {
              clientInfo.inspectionDate = rawProps.inspectionDate;
            }
          } else {
            clientInfo.inspectionDate = rawProps.inspectionDate;
          }
        }
      } catch(e) {
        console.warn("ClientInfo parse error:", e);
      }
    }

    // 2. TabbedPanes.tpl (Systems & Rooms)
    const tabNames = [];
    const tplStr = xmlFiles['tabbedpanes.tpl'] || xmlFiles['TabbedPanes.tpl'] || '';
    if (tplStr) {
      try {
        const dp = new DOMParser();
        const doc = dp.parseFromString(sanitizeXmlString(tplStr), "text/xml");
        const voids = doc.getElementsByTagName('void');
        for (let i = 0; i < voids.length; i++) {
          const v = voids[i];
          if (v.getAttribute && v.getAttribute('property') === 'tabbedPaneName') {
            const strings = v.getElementsByTagName('string');
            const txt = strings.length > 0 ? strings[0].textContent.trim() : v.textContent.trim();
            if (txt && !tabNames.includes(txt)) {
              tabNames.push(txt);
            }
          }
        }
      } catch(e) {
        console.warn("TabbedPanes parse error:", e);
      }
    }

    // 3. PhotoInfo.xml
    const photosByAreaItem = {};
    let unassignedPhotos = [];
    const photoXmlStr = xmlFiles['photoinfo.xml'] || xmlFiles['PhotoInfo.xml'] || '';
    if (photoXmlStr) {
      try {
        const dp = new DOMParser();
        const doc = dp.parseFromString(sanitizeXmlString(photoXmlStr), "text/xml");
        const objects = doc.getElementsByTagName('object');
        for (let i = 0; i < objects.length; i++) {
          const pObj = objects[i];
          if (pObj.getAttribute && pObj.getAttribute('class') === 'homeinspectorpro.PhotoInfo') {
            const pData = {};
            const childVoids = getChildTags(pObj, 'void');
            for (let j = 0; j < childVoids.length; j++) {
              const v = childVoids[j];
              const prop = v.getAttribute('property');
              if (prop) pData[prop] = v.textContent.trim();
            }

            const fname = pData.fileName || '';
            if (!fname) continue;

            const caption = pData.caption || '';
            const area = (pData.areaName || '').trim();
            const item = (pData.itemName || '').trim();
            const baseFname = fname.split('/').pop().split('\\').pop();
            const dUrl = imageMap[fname] || imageMap[baseFname] || imageMap[baseFname.toLowerCase()] || '';

            const photoRecord = { filename: fname, dataUrl: dUrl, caption: caption };
            if (area || item) {
              const k = `${area.toLowerCase()}|${item.toLowerCase()}`;
              if (!photosByAreaItem[k]) photosByAreaItem[k] = [];
              photosByAreaItem[k].push(photoRecord);
            } else {
              unassignedPhotos.push(photoRecord);
            }
          }
        }
      } catch(e) {
        console.warn("PhotoInfo parse error:", e);
      }
    }

    // 4. DamagePanels.xml
    const panelsByAreaItem = {};
    const damageXmlStr = xmlFiles['damagepanels.xml'] || xmlFiles['DamagePanels.xml'] || '';
    if (damageXmlStr) {
      try {
        const dp = new DOMParser();
        const doc = dp.parseFromString(sanitizeXmlString(damageXmlStr), "text/xml");
        const objects = doc.getElementsByTagName('object');
        for (let i = 0; i < objects.length; i++) {
          const pObj = objects[i];
          if (pObj.getAttribute && pObj.getAttribute('class') === 'homeinspectorpro.DamagePanelInfo') {
            let pName = "";
            const redNotes = [];
            const blackNotes = [];
            const generalNotes = [];

            const childVoids = getChildTags(pObj, 'void');
            for (let j = 0; j < childVoids.length; j++) {
              const v = childVoids[j];
              const prop = v.getAttribute('property');
              if (prop === 'name') {
                pName = v.textContent.trim();
              } else if (prop === 'damageStatusRedVector') {
                const strings = v.getElementsByTagName('string');
                for (let k = 0; k < strings.length; k++) {
                  const t = strings[k].textContent.trim();
                  if (t) redNotes.push(t);
                }
              } else if (prop === 'damageStatusBlackVector') {
                const strings = v.getElementsByTagName('string');
                for (let k = 0; k < strings.length; k++) {
                  const t = strings[k].textContent.trim();
                  if (t) blackNotes.push(t);
                }
              } else if (prop === 'damageStatusVector') {
                const strings = v.getElementsByTagName('string');
                for (let k = 0; k < strings.length; k++) {
                  const t = strings[k].textContent.trim();
                  if (t) generalNotes.push(t);
                }
              }
            }

            if (!pName) continue;

            let matchedTab = null;
            let matchedItem = pName;
            for (const t of tabNames) {
              if (pName.toLowerCase().startsWith(t.toLowerCase())) {
                matchedTab = t;
                matchedItem = pName.substring(t.length).trim();
                break;
              }
            }
            if (!matchedTab) {
              matchedTab = "General";
              matchedItem = pName;
            }
            if (!matchedItem) matchedItem = matchedTab;

            const key = `${matchedTab.toLowerCase()}|${matchedItem.toLowerCase()}`;
            panelsByAreaItem[key] = {
              tab: matchedTab,
              item: matchedItem,
              red: redNotes,
              black: blackNotes,
              general: generalNotes
            };
          }
        }
      } catch(e) {
        console.warn("DamagePanels parse error:", e);
      }
    }

    // 5. SelectionPanels.xml (Materials & Specs)
    const selectionsByAreaItem = {};
    const selXmlStr = xmlFiles['selectionpanels.xml'] || xmlFiles['SelectionPanels.xml'] || '';
    if (selXmlStr) {
      try {
        const dp = new DOMParser();
        const doc = dp.parseFromString(sanitizeXmlString(selXmlStr), "text/xml");
        const objects = doc.getElementsByTagName('object');
        for (let i = 0; i < objects.length; i++) {
          const sObj = objects[i];
          if (sObj.getAttribute && sObj.getAttribute('class') === 'homeinspectorpro.SelectionPanelInfo') {
            let pName = "";
            let desc = "";
            const materials = [];
            const indices = [];

            const childVoids = getChildTags(sObj, 'void');
            for (let j = 0; j < childVoids.length; j++) {
              const v = childVoids[j];
              const prop = v.getAttribute('property');
              if (prop === 'name') pName = v.textContent.trim();
              else if (prop === 'description') desc = v.textContent.trim();
              else if (prop === 'materialTypesVector') {
                const strings = v.getElementsByTagName('string');
                for (let k = 0; k < strings.length; k++) {
                  const t = strings[k].textContent.trim();
                  if (t) materials.push(t);
                }
              } else if (prop === 'selectedIndices') {
                const ints = v.getElementsByTagName('int');
                for (let k = 0; k < ints.length; k++) {
                  const n = parseInt(ints[k].textContent.trim(), 10);
                  if (!isNaN(n)) indices.push(n);
                }
              }
            }

            if (pName && indices.length > 0 && materials.length > 0) {
              const chosen = indices.map(idx => materials[idx]).filter(Boolean);
              if (chosen.length > 0) {
                let matchedTab = null;
                let matchedItem = pName;
                for (const t of tabNames) {
                  if (pName.toLowerCase().startsWith(t.toLowerCase())) {
                    matchedTab = t;
                    matchedItem = pName.substring(t.length).trim();
                    break;
                  }
                }
                if (!matchedTab) matchedTab = "General";
                if (!matchedItem) matchedItem = desc || matchedTab;
                const key = `${matchedTab.toLowerCase()}|${matchedItem.toLowerCase()}`;
                selectionsByAreaItem[key] = chosen;
              }
            }
          }
        }
      } catch(e) {
        console.warn("SelectionPanels parse error:", e);
      }
    }

    // Tab names fallback
    if (tabNames.length === 0) {
      const tabSet = new Set();
      Object.keys(panelsByAreaItem).forEach(k => tabSet.add(k.split('|')[0]));
      Object.keys(photosByAreaItem).forEach(k => tabSet.add(k.split('|')[0]));
      tabNames.push(...Array.from(tabSet));
      if (tabNames.length === 0) tabNames.push("General Inspection");
    }

    // 6. Assemble Final Sections & Items
    let secIdx = 1;
    let itemCounter = 1;

    for (const tab of tabNames) {
      const tabLower = tab.toLowerCase();
      const secItems = [];
      const seenItems = new Set();

      // Damage Panels
      for (const [key, pInfo] of Object.entries(panelsByAreaItem)) {
        const [aLow, iLow] = key.split('|');
        if (aLow === tabLower) {
          seenItems.add(iLow);
          const reds = pInfo.red;
          const blacks = pInfo.black;
          const generals = pInfo.general;

          let status = "Satisfactory";
          if (reds.length > 0) {
            const isHazard = reds.some(r => /hazard|danger|safety|shock|seepage|moisture|fire/i.test(r));
            status = isHazard ? "Safety Hazard" : "Defective";
          } else if (blacks.length > 0) {
            status = "Marginal";
          }

          const commentBlocks = [];
          let matSpecs = selectionsByAreaItem[key] || [];
          if (matSpecs.length === 0) {
            for (const [sKey, sList] of Object.entries(selectionsByAreaItem)) {
              const [saLow, siLow] = sKey.split('|');
              if (saLow === aLow && (siLow.includes(iLow) || iLow.includes(siLow))) {
                matSpecs = sList;
                break;
              }
            }
          }
          if (matSpecs.length > 0) {
            commentBlocks.push("• Materials & Specs: " + matSpecs.join(", "));
          }
          if (reds.length > 0) commentBlocks.push("• " + reds.join("\n• "));
          if (blacks.length > 0) commentBlocks.push("• " + blacks.join("\n• "));
          if (generals.length > 0 && reds.length === 0 && blacks.length === 0) {
            commentBlocks.push("• " + generals.join("\n• "));
          }

          let itemPhotos = photosByAreaItem[key] || [];
          if (itemPhotos.length === 0) {
            for (const [pKey, pList] of Object.entries(photosByAreaItem)) {
              const [paLow, piLow] = pKey.split('|');
              if (paLow === tabLower && (piLow.includes(iLow) || iLow.includes(piLow))) {
                itemPhotos = pList;
                break;
              }
            }
          }

          secItems.push({
            id: `it_hip_${itemCounter++}`,
            name: pInfo.item,
            status: status,
            comments: commentBlocks.join("\n\n"),
            photos: itemPhotos
          });
        }
      }

      // Remaining photos in this area
      for (const [pKey, pList] of Object.entries(photosByAreaItem)) {
        const [paLow, piLow] = pKey.split('|');
        if (paLow === tabLower && !seenItems.has(piLow)) {
          seenItems.add(piLow);
          secItems.push({
            id: `it_hip_${itemCounter++}`,
            name: piLow.replace(/\b\w/g, l => l.toUpperCase()) || "Inspection Photos",
            status: "Satisfactory",
            comments: "",
            photos: pList
          });
        }
      }

      // Overview photos under details tab
      if (/detail/i.test(tabLower) && unassignedPhotos.length > 0) {
        secItems.push({
          id: `it_hip_${itemCounter++}`,
          name: "Cover & Overview Photos",
          status: "Satisfactory",
          comments: "Inspection overview and cover photos",
          photos: unassignedPhotos
        });
        unassignedPhotos = [];
      }

      if (secItems.length > 0) {
        sections.push({
          id: `sec_hip_${secIdx++}`,
          name: tab,
          summary: `${secItems.length} inspection checkpoints in ${tab}`,
          items: secItems
        });
      }
    }

    if (unassignedPhotos.length > 0) {
      sections.push({
        id: `sec_hip_${secIdx++}`,
        name: "General Overview Photos",
        summary: `${unassignedPhotos.length} unclassified inspection photos`,
        items: [{
          id: `it_hip_${itemCounter++}`,
          name: "Overview Photos",
          status: "Satisfactory",
          comments: "",
          photos: unassignedPhotos
        }]
      });
    }

    return { clientInfo, sections };
  }

  // Load User's Actual .hzf or .bin File
  async function loadUserFile(file) {
    if (State.isInspectionActive && State.sections && State.sections.length > 0 && State.isDirty) {
      const confirmOpen = window.confirm(
        "You have unsaved changes in your current inspection! Do you want to open another file?\n\n" +
        "Click OK to proceed (unsaved changes will be replaced), or Cancel to stay."
      );
      if (!confirmOpen) return;
    }

    showToast(`Parsing ${file.name}...`);
    State.fileName = file.name;
    State.activeReportId = null;

    // 1. Try Backend Upload API
    try {
      const formData = new FormData();
      formData.append("file", file);

      const resp = await fetch(apiUrl("/api/upload-hzf"), {
        method: "POST",
        body: formData
      });

      if (resp.ok) {
        const json = await resp.json();
        if (json.success && json.data) {
          State.clientInfo = json.data.clientInfo || {};
          State.sections = json.data.sections || [];
          State.activeSectionId = State.sections[0] ? State.sections[0].id : null;
          State.isDirty = false;
          setWorkspaceActive(true);
          await saveActiveSession();
          showToast(`Loaded ${file.name}!`);
          return;
        }
      }
    } catch (e) {
      console.log("Backend offline, using JSZip browser fallback...");
    }

    // 2. Client-side JSZip Fallback
    if (window.JSZip) {
      try {
        const zip = await JSZip.loadAsync(file);
        const imageMap = {};
        const xmlFiles = {};

        for (const fname of Object.keys(zip.files)) {
          const entry = zip.files[fname];
          if (entry.dir) continue;
          const lower = fname.toLowerCase();

          if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) {
            const blob = await entry.async("blob");
            const dataUrl = await new Promise(r => {
              const reader = new FileReader();
              reader.onload = () => r(reader.result);
              reader.readAsDataURL(blob);
            });
            const baseName = fname.split('/').pop().split('\\').pop();
            imageMap[baseName] = dataUrl;
            imageMap[baseName.toLowerCase()] = dataUrl;
            imageMap[fname] = dataUrl;
            imageMap[fname.toLowerCase()] = dataUrl;
          } else if (lower.endsWith('.xml') || lower.endsWith('.tpl') || lower.endsWith('.dat')) {
            const bName = fname.split('/').pop().split('\\').pop();
            const txt = await entry.async("text");
            xmlFiles[bName] = txt;
            xmlFiles[bName.toLowerCase()] = txt;
            xmlFiles[fname] = txt;
            xmlFiles[fname.toLowerCase()] = txt;
          }
        }

        // 1. Check if this archive has lossless HZF Studio InspectionData.xml first
        const hasInspectionData = xmlFiles['inspectiondata.xml'] || xmlFiles['InspectionData.xml'] || xmlFiles['report.xml'];

        if (hasInspectionData) {
          State.clientInfo = {};

          // Check embedded ClientInfo inside InspectionData.xml
          const inspXml = hasInspectionData;
          const dp = new DOMParser();
          const inspDoc = dp.parseFromString(sanitizeXmlString(inspXml), "text/xml");

          const embeddedClient = inspDoc.querySelector('ClientInfo') || inspDoc.querySelector('clientinfo');
          if (embeddedClient) {
            Array.from(embeddedClient.children).forEach(el => {
              const val = el.textContent.trim();
              if (val) {
                State.clientInfo[el.tagName] = val;
                const tLow = el.tagName.toLowerCase();
                if (tLow.includes('address')) State.clientInfo.inspectionAddress = val;
                else if (tLow.includes('clientname') || tLow === 'client') State.clientInfo.clientName = val;
                else if (tLow.includes('phone')) State.clientInfo.clientPhone = val;
                else if (tLow.includes('email')) State.clientInfo.clientEmail = val;
                else if (tLow.includes('inspectorname') || tLow === 'inspector') State.clientInfo.inspectorName = val;
                else if (tLow.includes('license')) State.clientInfo.inspectorLicense = val;
                else if (tLow.includes('company')) State.clientInfo.inspectionCompany = val;
                else if (tLow.includes('date')) State.clientInfo.inspectionDate = val;
                else if (tLow.includes('time')) State.clientInfo.inspectionTime = val;
                else if (tLow.includes('weather')) State.clientInfo.weather = val;
                else if (tLow.includes('propertytype')) State.clientInfo.propertyType = val;
                else if (tLow.includes('yearbuilt')) State.clientInfo.yearBuilt = val;
                else if (tLow.includes('sqft') || tLow.includes('squarefootage')) State.clientInfo.squareFootage = val;
              }
            });
          }

          // Also check separate ClientInfo.xml (Java XMLDecoder or standard)
          const clientXml = xmlFiles['ClientInfo.xml'] || xmlFiles['clientinfo.xml'] || xmlFiles['client.xml'] || '';
          if (clientXml) {
            const clientDoc = dp.parseFromString(sanitizeXmlString(clientXml), "text/xml");
            // Check Java XMLDecoder <void property="...">
            clientDoc.querySelectorAll('void[property]').forEach(v => {
              const prop = v.getAttribute('property');
              const str = (v.querySelector('string')?.textContent || v.textContent || '').trim();
              if (str) {
                if (prop === 'address') State.clientInfo.inspectionAddress = str;
                else if (prop === 'firstName' || prop === 'clientName') State.clientInfo.clientName = str;
                else if (prop === 'phone' || prop === 'clientPhone') State.clientInfo.clientPhone = str;
                else if (prop === 'email' || prop === 'clientEmail') State.clientInfo.clientEmail = str;
                else if (prop === 'inspectorName') State.clientInfo.inspectorName = str;
                else if (prop === 'company' || prop === 'inspectionCompany') State.clientInfo.inspectionCompany = str;
                else if (prop === 'license' || prop === 'inspectorLicense') State.clientInfo.inspectorLicense = str;
                else if (prop === 'inspectionDate') State.clientInfo.inspectionDate = str;
                else if (prop === 'inspectionTime') State.clientInfo.inspectionTime = str;
                else if (prop === 'weather') State.clientInfo.weather = str;
                else if (prop === 'otherInfo' || prop === 'propertyType') State.clientInfo.propertyType = str;
                else if (prop === 'yearBuilt') State.clientInfo.yearBuilt = str;
                else if (prop === 'squareFootage') State.clientInfo.squareFootage = str;
              }
            });

            // Check standard tags
            const tags = ["clientName", "inspectionAddress", "inspectorName", "inspectionCompany", "inspectorLicense", "inspectionDate", "inspectionTime", "weather", "propertyType", "yearBuilt", "squareFootage"];
            tags.forEach(t => {
              const el = clientDoc.querySelector(t) || clientDoc.querySelector(t.toLowerCase());
              if (el && el.textContent.trim()) State.clientInfo[t] = el.textContent.trim();
            });
          }

          const parsedSections = [];
          inspDoc.querySelectorAll('Section').forEach((sNode, sIdx) => {
            const sName = sNode.getAttribute('name') || sNode.querySelector('Name')?.textContent || `Section ${sIdx + 1}`;
            const items = [];
            sNode.querySelectorAll('Item').forEach((iNode, iIdx) => {
              const iName = iNode.getAttribute('name') || iNode.querySelector('Name')?.textContent || `Item ${iIdx + 1}`;
              const status = iNode.querySelector('Status')?.textContent || "Satisfactory";
              const comments = iNode.querySelector('Comments')?.textContent || "";
              const photos = [];
              iNode.querySelectorAll('Photo').forEach(pNode => {
                const pFile = pNode.getAttribute('filename') || pNode.textContent.trim();
                const pCap = pNode.getAttribute('caption') || "";
                const baseF = pFile ? pFile.split('/').pop().split('\\').pop() : '';
                const dUrl = (
                  imageMap[pFile] ||
                  imageMap[baseF] ||
                  imageMap[pFile.toLowerCase()] ||
                  imageMap[baseF.toLowerCase()] ||
                  ""
                );
                if (pFile || baseF) {
                  photos.push({ filename: baseF || pFile, dataUrl: dUrl, caption: pCap });
                }
              });
              items.push({ id: `it_${sIdx}_${iIdx}`, name: iName, status, comments, photos });
            });
            parsedSections.push({
              id: `sec_${sIdx}`,
              name: sName,
              desc: sNode.querySelector('Summary')?.textContent || "",
              items: items
            });
          });

          State.sections = parsedSections.length > 0 ? parsedSections : [
            {
              id: "sec_imported",
              name: "Imported Components",
              desc: "Items from " + file.name,
              items: Object.entries(imageMap).map(([k, v], idx) => ({
                id: `it_${idx}`,
                name: k.replace(/\.[^/.]+$/, "").replace(/_/g, " "),
                status: "Satisfactory",
                comments: "",
                photos: [{ filename: k, dataUrl: v, caption: "" }]
              }))
            }
          ];
        } else {
          // Fallback to native Home Inspector Pro format
          const hipResult = parseHipFormatJs(xmlFiles, imageMap);
          State.clientInfo = hipResult.clientInfo || {};
          State.sections = hipResult.sections || [];
        }

        State.activeSectionId = State.sections[0] ? State.sections[0].id : null;
        State.isDirty = false;
        setWorkspaceActive(true);
        await saveActiveSession();
        showToast(`Loaded ${file.name}!`);
      } catch (err) {
        showToast("Error reading file: " + err.message);
      }
    }
  }


  // Update Metrics
  function updateMetrics() {
    let hazards = 0, defects = 0, marginal = 0, good = 0;

    State.sections.forEach(s => {
      (s.items || []).forEach(i => {
        if (i.status === 'Safety Hazard') hazards++;
        else if (i.status === 'Defective') defects++;
        else if (i.status === 'Marginal') marginal++;
        else if (i.status === 'Satisfactory') good++;
      });
    });

    document.getElementById('countHazard').textContent = hazards;
    document.getElementById('countDefect').textContent = defects;
    document.getElementById('countMarginal').textContent = marginal;
    document.getElementById('countGood').textContent = good;
  }

  // Render Sidebar
  function renderSidebar() {
    const list = document.getElementById('categoriesList');
    if (!list) return;
    list.innerHTML = '';

    State.sections.forEach(sec => {
      let issues = 0;
      (sec.items || []).forEach(it => {
        if (['Safety Hazard', 'Defective', 'Marginal'].includes(it.status)) issues++;
      });

      const btn = document.createElement('button');
      btn.className = `category-nav-btn ${sec.id === State.activeSectionId ? 'active' : ''}`;
      btn.innerHTML = `
        <span>${sec.name}</span>
        ${issues > 0 ? `<span class="category-badge has-defects">${issues}</span>` : `<span class="category-badge">${(sec.items || []).length}</span>`}
      `;

      btn.onclick = () => {
        State.activeSectionId = sec.id;
        renderSidebar();
        renderItems();
        saveActiveSession();
      };

      list.appendChild(btn);
    });
  }

  // Render Items for Active Section
  function renderItems() {
    const stream = document.getElementById('itemsStream');
    const sec = State.sections.find(s => s.id === State.activeSectionId) || State.sections[0];
    if (!stream || !sec) return;

    document.getElementById('activeSectionName').textContent = sec.name;
    document.getElementById('activeSectionDesc').textContent = sec.desc || "";

    stream.innerHTML = '';

    if (!sec.items || sec.items.length === 0) {
      stream.innerHTML = `
        <div style="text-align: center; padding: 2.5rem; color: var(--text-muted); border: 1px dashed var(--border); border-radius: var(--radius-md);">
          <p>No checklist items in this section yet.</p>
          <button class="btn btn-outline btn-sm" style="margin-top: 0.75rem;" onclick="document.getElementById('btnOpenAddItemModal').click()">+ Add First Item</button>
        </div>
      `;
      return;
    }

    sec.items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'clean-item-card';

      // Photos HTML
      let photosHtml = '';
      (item.photos || []).forEach((p, pIdx) => {
        photosHtml += `
          <div class="photo-thumb" onclick="window.App.openPhoto('${sec.id}', '${item.id}', ${pIdx})" title="${p.caption || 'Click to enlarge / caption'}">
            <img src="${p.dataUrl}" alt="${p.filename}">
          </div>
        `;
      });

      card.innerHTML = `
        <div class="item-card-top">
          <span class="item-name">${item.name}</span>

          <!-- Segmented Status Selector -->
          <div class="segmented-status">
            <button class="status-btn ${item.status === 'Satisfactory' ? 'active-good' : ''}" 
              onclick="window.App.setStatus('${sec.id}', '${item.id}', 'Satisfactory')">Good</button>
            <button class="status-btn ${item.status === 'Marginal' ? 'active-marginal' : ''}" 
              onclick="window.App.setStatus('${sec.id}', '${item.id}', 'Marginal')">Marginal</button>
            <button class="status-btn ${item.status === 'Defective' ? 'active-defect' : ''}" 
              onclick="window.App.setStatus('${sec.id}', '${item.id}', 'Defective')">Defect</button>
            <button class="status-btn ${item.status === 'Safety Hazard' ? 'active-hazard' : ''}" 
              onclick="window.App.setStatus('${sec.id}', '${item.id}', 'Safety Hazard')">Hazard</button>
          </div>
        </div>

        <div class="item-notes-wrap">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
            <label style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; color: var(--text-muted);">Observations & Narrative</label>
            <button type="button" class="btn-polish-item ${(!item.comments || !item.comments.trim()) && (item.photos && item.photos.length > 0) ? 'btn-polish-vision' : ''}" onclick="window.App.polishItem('${sec.id}', '${item.id}')" title="${(!item.comments || !item.comments.trim()) && (item.photos && item.photos.length > 0) ? 'Inspect photo with Gemini Vision & fill observations' : 'AI Polish this field note'}">
              <i data-lucide="${(!item.comments || !item.comments.trim()) && (item.photos && item.photos.length > 0) ? 'camera' : 'sparkles'}" style="width: 12px; height: 12px;"></i>
              <span>${(!item.comments || !item.comments.trim()) && (item.photos && item.photos.length > 0) ? 'AI Inspect Photo' : 'AI Polish'}</span>
            </button>
          </div>
          <textarea class="clean-textarea" id="notes_${item.id}"
            placeholder="Add inspector notes, defect findings, or repair recommendations..."
            oninput="window.App.setComments('${sec.id}', '${item.id}', this.value)"
            onchange="window.App.setComments('${sec.id}', '${item.id}', this.value)">${item.comments || ''}</textarea>
        </div>

        <div class="photos-strip">
          ${photosHtml}
          <input type="file" id="up_${item.id}" accept="image/*" style="display:none;" onchange="window.App.uploadPhoto('${sec.id}', '${item.id}', this)">
          <button type="button" class="btn-upload-photo" onclick="document.getElementById('up_${item.id}').click()" title="Attach photo from gallery or computer">
            <i data-lucide="image"></i>
            <span>+ Photo</span>
          </button>
          <button type="button" class="btn-live-photo" onclick="window.App.openLiveCamera('${sec.id}', '${item.id}')" title="Open camera to snap live defect photo and crop">
            <i data-lucide="camera"></i>
            <span>Live Photo</span>
          </button>
        </div>
      `;

      stream.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
  }

  // XML character escaping for 100% valid XML exports
  function escapeXml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe).replace(/[<>&'"]/g, c => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
    });
  }

  // Sync Form Input fields to State
  function syncFormToState() {
    State.clientInfo = {
      ...(State.clientInfo || {}),
      inspectionAddress: document.getElementById('formAddress')?.value || State.clientInfo?.inspectionAddress || '',
      propertyType: document.getElementById('formPropertyType')?.value || State.clientInfo?.propertyType || '',
      yearBuilt: document.getElementById('formYearBuilt')?.value || State.clientInfo?.yearBuilt || '',
      squareFootage: document.getElementById('formSqFt')?.value || State.clientInfo?.squareFootage || '',
      weather: document.getElementById('formWeather')?.value || State.clientInfo?.weather || '',
      clientName: document.getElementById('formClientName')?.value || State.clientInfo?.clientName || '',
      clientPhone: document.getElementById('formClientPhone')?.value || State.clientInfo?.clientPhone || '',
      clientEmail: document.getElementById('formClientEmail')?.value || State.clientInfo?.clientEmail || '',
      inspectionDate: document.getElementById('formInspectionDate')?.value || State.clientInfo?.inspectionDate || '',
      inspectionTime: document.getElementById('formInspectionTime')?.value || State.clientInfo?.inspectionTime || '',
      inspectorName: document.getElementById('formInspectorName')?.value || State.clientInfo?.inspectorName || '',
      inspectorLicense: document.getElementById('formInspectorLicense')?.value || State.clientInfo?.inspectorLicense || '',
      inspectionCompany: document.getElementById('formCompanyName')?.value || State.clientInfo?.inspectionCompany || ''
    };

    // Also sync all visible note textareas so in-progress notes are never lost
    document.querySelectorAll('textarea[id^="notes_"]').forEach(ta => {
      const itemId = ta.id.replace('notes_', '');
      for (const s of (State.sections || [])) {
        const it = (s.items || []).find(i => i.id === itemId);
        if (it) {
          it.comments = ta.value;
          break;
        }
      }
    });

    State.isDirty = true;
    debouncedSaveSession();
  }

  // Render Property Info Form
  function renderPropertyForm() {
    const c = State.clientInfo || {};
    const map = {
      formAddress: c.inspectionAddress || '',
      formPropertyType: c.propertyType || '',
      yearBuilt: c.yearBuilt || '',
      formSqFt: c.squareFootage || '',
      formWeather: c.weather || '',
      formClientName: c.clientName || '',
      formClientPhone: c.clientPhone || '',
      formClientEmail: c.clientEmail || '',
      formInspectionDate: c.inspectionDate || '',
      formInspectionTime: c.inspectionTime || '',
      formInspectorName: c.inspectorName || '',
      formInspectorLicense: c.inspectorLicense || '',
      formCompanyName: c.inspectionCompany || ''
    };

    for (const [id, val] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.value = val;
    }

    // Hero Bar sync
    document.getElementById('heroPropertyAddress').textContent = c.inspectionAddress || "Inspection Property";
    document.getElementById('metaClientName').textContent = c.clientName || "Not Specified";
    document.getElementById('metaInspectorName').textContent = c.inspectorName ? `${c.inspectorName} (${c.inspectorLicense || ''})` : "Inspector";
    document.getElementById('metaDate').textContent = c.inspectionDate || "Today";
    document.getElementById('activeFilePill').textContent = State.fileName || "Inspection";
  }

  // ==========================================================================
  // EXACT PDF REPLICA ENGINE FOR REPORT PREVIEW (TAB 3)
  // Matches Mantra Mirari Flat No.E-404.pdf (Home Inspector Pro layout)
  // ==========================================================================

  // 5-Column Rating Matrix builder for HIP Replica
  function buildStatusMatrixHtml(statusStr) {
    const st = (statusStr || '').trim().toLowerCase();
    let checkedIdx = 4; // Default 'None'
    if (st.includes('satisfactory') || st.includes('pass') || st.includes('acceptable') || st.includes('good')) {
      checkedIdx = 0;
    } else if (st.includes('marginal') || st.includes('fair') || st.includes('maintenance')) {
      checkedIdx = 1;
    } else if (st.includes('defective') || st.includes('defect') || st.includes('safety hazard') || st.includes('hazard') || st.includes('poor') || st.includes('damaged') || st.includes('leak')) {
      checkedIdx = 2;
    } else if (st.includes('n/a') || st.includes('not present') || st.includes('not inspected') || st.includes('ni') || st.includes('np')) {
      checkedIdx = 3;
    }

    const cols = [
      { label: 'Accept<br/>able', idx: 0 },
      { label: 'Margin<br/>al', idx: 1 },
      { label: 'Defecti<br/>ve', idx: 2 },
      { label: 'N/A', idx: 3 },
      { label: 'None', idx: 4 }
    ];

    return `
      <div class="hip-matrix-wrap">
        <div class="hip-matrix">
          ${cols.map(c => `
            <div class="hip-matrix-cell">
              <div class="hip-matrix-hdr">${c.label}</div>
              <div class="hip-matrix-box">${c.idx === checkedIdx ? '<span class="hip-matrix-x">X</span>' : ''}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Pure function to generate clean, pixel-accurate inspection report HTML matching PDF
  function generateReportHtml(clientInfo, sections) {
    const c = clientInfo || {};
    const companyName = c.inspectionCompany || "N G Home Inspection Services";
    const inspectorName = c.inspectorName || "Nitin Gujarathi";
    const phone = c.clientPhone || "00919890002635";
    const email = c.clientEmail || "niting@macj.in";
    const officeAddress = "4_4 Yugaymangal complex, Kothrud, Pune, Maharashtra 411038";
    const propAddress = c.inspectionAddress || "Flat No.E-404, Mantra Mirari, Mundhwa, Pune, Maharashtra, 411036";
    const clientName = c.clientName || "Valued Client";
    const agentName = c.realEstateAgent || "SC,SS,STE(AK)  -";
    const inspDate = c.inspectionDate || "9/24/2026";
    const inspTime = c.inspectionTime || "11.30 PM";
    const weather = c.weather || "Cloudy";
    const propType = c.propertyType || "4.5BHK on 4th Floor";

    // Running header address: 2 parts
    const addrParts = propAddress.split(',');
    const addressShort = addrParts.length > 2 ? `${addrParts[0].trim()}, ${addrParts[1].trim()}, ${addrParts[2].trim()}` : propAddress;

    const pages = [];
    const navItems = [];

    // --------------------------------------------------------------------------
    // PAGE 1: COVER PAGE
    // --------------------------------------------------------------------------
    let coverImgUrl = selectedPdfCoverPhoto;
    if (!coverImgUrl) {
      for (const s of (sections || [])) {
        for (const it of (s.items || [])) {
          if (it.photos && it.photos.length > 0 && it.photos[0].dataUrl) {
            coverImgUrl = it.photos[0].dataUrl;
            break;
          }
        }
        if (coverImgUrl) break;
      }
    }
    if (!coverImgUrl) {
      coverImgUrl = "/assets/default_cover.jpeg";
    }

    const coverHtml = `
      <div class="hip-cover-banner">
        <div class="hip-cover-company">${escapeXml(companyName)}</div>
        <div class="hip-cover-title">Property Inspection Report</div>
      </div>
      <div class="hip-cover-hero">
        <img src="${coverImgUrl}" class="hip-cover-img" alt="Building Cover Photo" />
      </div>
      <div class="hip-cover-meta">
        <div class="hip-cover-address"><strong>${escapeXml(propAddress)}</strong></div>
        <div>Inspection prepared for: <strong>${escapeXml(clientName)}</strong></div>
        <div>Real Estate Agent: ${escapeXml(agentName)}</div>
        <div>Date of Inspection: ${escapeXml(inspDate)} &nbsp; Time: ${escapeXml(inspTime)}</div>
        <div>Weather: ${escapeXml(weather)}</div>
        <div class="hip-cover-type"><strong>${escapeXml(propType)}</strong></div>
        <div class="hip-cover-divider"></div>
        <div>Inspector: <strong>${escapeXml(inspectorName)}</strong></div>
        <div>${escapeXml(officeAddress)}</div>
        <div>Phone: ${escapeXml(phone)}</div>
        <div>Email: ${escapeXml(email)}</div>
      </div>
    `;
    pages.push({ pageId: 'page_cover', isCover: true, title: 'Cover Page', html: coverHtml });
    navItems.push({ pageId: 'page_cover', title: 'Cover Page' });

    // --------------------------------------------------------------------------
    // PAGE 2: INSPECTION DETAILS
    // --------------------------------------------------------------------------
    const inspDetailsSec = (sections || []).find(s => (s.name || '').trim().toLowerCase() === "inspection details");
    let extraDetailsHtml = '';
    if (inspDetailsSec) {
      const extraItems = (inspDetailsSec.items || []).filter(it => !(it.name || '').toLowerCase().includes('wall reference'));
      extraItems.forEach((item, idx) => {
        extraDetailsHtml += `
          <div class="hip-item-banner">${5 + idx}. ${escapeXml(item.name || 'Detail')}</div>
          ${item.comments ? `<div style="font-size: 12px; margin-bottom: 6px;">${escapeXml(item.comments)}</div>` : ''}
        `;
      });
    }

    const detailsHtml = `
      <div class="hip-sec-title">Inspection Details</div>
      <div class="hip-intro-block">
        <div class="hip-intro-heading">INTRODUCTION:</div>
        <p>We appreciate the opportunity to conduct this inspection for you! Please carefully read your entire Inspection Report. Call us after you have reviewed your report, so we can go over any questions you may have. Remember, when the inspection is completed and the report is delivered, we are still available to you for any questions you may have, throughout the entire closing process.</p>
        <p>Properties being inspected do not "Pass" or "Fail." - The following report is based on an inspection of the visible portion of the structure; inspection may be limited by vegetation and possessions. Depending upon the age of the property, some items like GFCI outlets may not be installed; this report will focus on safety and function, not current code. This report identifies specific non-code, non-cosmetic concerns that the inspector feels may need further investigation or repair.</p>
        <p>For your safety and liability purposes, we recommend that licensed contractors evaluate and repair any critical concerns and defects. Note that this report is a snapshot in time. We recommend that you or your representative carry out a final walk-through inspection immediately before closing to check the condition of the property, using this report as a guide.</p>
      </div>

      <div class="hip-item-banner">1. Attendance</div>
      <div style="font-size: 12px; margin-bottom: 6px;">In Attendance: Site team present.</div>

      <div class="hip-item-banner">2. Home Type</div>
      <div style="font-size: 12px; margin-bottom: 6px;">Home Type: ${escapeXml(propType)}.</div>

      <div class="hip-item-banner">3. Occupancy</div>
      <div style="font-size: 12px; margin-bottom: 6px;">Occupancy: Vacant</div>

      <div class="hip-item-banner">4. Wall Reference</div>
      <div style="text-align: center; margin-top: 4px;">
        <div style="display: inline-block; margin-bottom: 4px;">${buildStatusMatrixHtml("n/a")}</div>
        <img src="/assets/wall_reference.jpeg" class="hip-wall-ref-img" alt="Wall Reference Compass Diagram" onerror="this.style.display='none'" />
        <div style="font-size: 11px; margin-top: 4px; color: #222;">For every area, Door/Entrance is the reference point to relate to the walls</div>
      </div>
      ${extraDetailsHtml}
    `;
    pages.push({ pageId: 'page_details', isCover: false, title: 'Inspection Details', html: detailsHtml });
    navItems.push({ pageId: 'page_details', title: 'Inspection Details' });

    // --------------------------------------------------------------------------
    // PAGES 3+: SYSTEMS & ROOMS SECTIONS
    // --------------------------------------------------------------------------
    const summaryFindings = [];
    const hasCustomGeneralRecom = (sections || []).some(s => (s.name || '').toLowerCase().includes('recommend'));

    (sections || []).forEach((sec, sIdx) => {
      const secName = sec.name || `Section ${sIdx + 1}`;
      if (secName.trim().toLowerCase() === "inspection details") return;

      const items = sec.items || [];
      if (!items || items.length === 0) return;

      const secPageId = `page_sec_${sIdx}`;
      navItems.push({ pageId: secPageId, title: secName });

      // Group items into reasonable chunks so pages match realistic paper sheets
      const itemsPerPage = 4;
      const itemChunks = [];
      for (let i = 0; i < items.length; i += itemsPerPage) {
        itemChunks.push(items.slice(i, i + itemsPerPage));
      }

      itemChunks.forEach((chunk, chunkIdx) => {
        let itemsHtml = '';
        if (chunkIdx === 0) {
          itemsHtml += `<div class="hip-sec-title">${escapeXml(secName)}</div>`;
        }

        chunk.forEach((it, itIdxWithinChunk) => {
          const globalItIdx = (chunkIdx * itemsPerPage) + itIdxWithinChunk;
          const itName = it.name || `Item ${globalItIdx + 1}`;
          const itStatus = it.status || 'Satisfactory';
          const commentsRaw = it.comments || '';
          const photos = it.photos || [];

          // Parse materials & observations
          const rawLines = commentsRaw.split('\n').map(l => l.trim()).filter(Boolean);
          const matLines = [];
          const obsLines = [];
          rawLines.forEach(l => {
            const clean = l.replace(/^[•\-\*\s]+/, '').trim();
            if (clean.toLowerCase().startsWith('materials:')) {
              matLines.push(clean.replace(/^materials:\s*/i, ''));
            } else if (clean.toLowerCase().startsWith('observations:')) {
              // skip label
            } else if (clean) {
              obsLines.push(clean);
            }
          });

          // Check defect rollup for Report Summary
          const stLower = itStatus.toLowerCase();
          const isDefective = ["defect", "hazard", "poor", "damaged", "leak"].some(k => stLower.includes(k));
          const isMarginal = ["marginal", "fair", "maintenance"].some(k => stLower.includes(k));
          if ((isDefective || isMarginal || obsLines.length > 0) && itName.toLowerCase() !== "location" && secName !== "Inspection Details") {
            summaryFindings.push({
              section: secName,
              itemIndex: globalItIdx + 1,
              itemName: itName,
              findings: obsLines.length > 0 ? obsLines : [`Condition marked as ${itStatus}.`]
            });
          }

          let rightContent = '';
          if (itName.toLowerCase() === "location" && photos.length > 0) {
            const inlineP = photos[0];
            rightContent = `
              <div class="hip-inline-photo">
                <img src="${inlineP.dataUrl}" alt="Location Reference" />
                <div class="hip-photo-cap">${escapeXml(inlineP.caption || 'Location')}</div>
              </div>
            `;
          } else {
            if (matLines.length > 0) {
              rightContent += `<div class="hip-materials"><strong>Materials:</strong> ${escapeXml(matLines.join(', '))}</div>`;
            }
            if (obsLines.length > 0) {
              rightContent += `<div class="hip-obs-heading">Observations:</div>`;
              obsLines.forEach(obs => {
                rightContent += `<div class="hip-obs-bullet">• ${escapeXml(obs)}</div>`;
              });
            }
            if (!matLines.length && !obsLines.length) {
              rightContent += `<div style="font-size: 11.5px; color: #444;">${itStatus}</div>`;
            }
          }

          itemsHtml += `
            <div class="hip-item-banner">${globalItIdx + 1}. ${escapeXml(itName)}</div>
            <div class="hip-item-row">
              ${buildStatusMatrixHtml(itStatus)}
              <div class="hip-item-content">
                ${rightContent}
              </div>
            </div>
          `;
        });

        pages.push({
          pageId: chunkIdx === 0 ? secPageId : `${secPageId}_p${chunkIdx + 1}`,
          isCover: false,
          title: secName,
          html: itemsHtml
        });
      });

      // Gallery photos for this section (2 columns x 3 rows = 6 photos per page)
      const allSecPhotos = [];
      items.forEach(it => {
        const isLoc = (it.name || '').toLowerCase() === "location";
        const itPhotos = isLoc ? (it.photos || []).slice(1) : (it.photos || []);
        itPhotos.forEach(p => {
          if (p.dataUrl) {
            allSecPhotos.push({
              dataUrl: p.dataUrl,
              caption: p.caption || it.name
            });
          }
        });
      });

      if (allSecPhotos.length > 0) {
        const photoChunks = [];
        for (let pIdx = 0; pIdx < allSecPhotos.length; pIdx += 6) {
          photoChunks.push(allSecPhotos.slice(pIdx, pIdx + 6));
        }

        photoChunks.forEach((pChunk, pcIdx) => {
          let photoPageHtml = '';
          if (pcIdx === 0) {
            photoPageHtml += `<div class="hip-sec-title">${escapeXml(secName)} - Photos</div>`;
          }
          photoPageHtml += `<div class="hip-photo-grid">`;
          pChunk.forEach(p => {
            photoPageHtml += `
              <div class="hip-photo-card">
                <img src="${p.dataUrl}" class="hip-photo-img" alt="${escapeXml(p.caption)}" />
                <div class="hip-photo-caption">${escapeXml(p.caption)}</div>
              </div>
            `;
          });
          photoPageHtml += `</div>`;

          pages.push({
            pageId: `${secPageId}_photos_${pcIdx + 1}`,
            isCover: false,
            title: `${secName} Photos`,
            html: photoPageHtml
          });
        });
      }
    });

    // --------------------------------------------------------------------------
    // GENERAL RECOMMENDATIONS (Fallback if not provided in sections)
    // --------------------------------------------------------------------------
    if (!hasCustomGeneralRecom) {
      const recomHtml = `
        <div class="hip-sec-title">General Recommendations</div>
        <div class="hip-item-banner">1. Wall Repair Methodology</div>
        <div style="font-size: 12px; line-height: 1.5; margin-top: 4px;">
          <div><strong>Hairline cracks, we recommend :</strong></div>
          <div style="margin-left: 12px;">Step 1 : Sanding along the crack, then proper putty filling,</div>
          <div style="margin-left: 12px;">Step 2 : Primer & paint finishing as per manufacture specification.</div>
          <div style="margin-top: 4px;"><strong>Significant cracks, we recommend :</strong></div>
          <div style="margin-left: 12px;">Step 1 : Making 2 mm cutting along the crack with diamond bladed hand grinder</div>
          <div style="margin-left: 12px;">Step 2 : Sanding off any loose materials and dirt</div>
          <div style="margin-left: 12px;">Step 3 : Plastering with dry mesh and suitable grade cement mortar</div>
          <div style="margin-left: 12px;">Step 4 : Primer & paint finishing as per manufacture specification.</div>
          <div style="margin-top: 4px;"><strong>Hollow plaster, we recommend :</strong></div>
          <div style="margin-left: 12px;">Step 1 : Hollow plaster to be chipped off till hard surface</div>
          <div style="margin-left: 12px;">Step 2 : Area to be re-plastered with suitable grade cement mortar</div>
        </div>

        <div class="hip-item-banner" style="margin-top: 14px;">2. Waterproofing & Plumbing Maintenance</div>
        <div style="font-size: 12px; line-height: 1.5; margin-top: 4px;">
          <div>• All bottle traps and angle valves with seepage should be dismantled, thread-taped, and refitted.</div>
          <div>• Pressure testing recommended for all concealed lines before completing civil touch-ups.</div>
          <div>• Maintain minimum 48-hour cure time for silicone sealant around counter tops and sanitary fittings.</div>
        </div>
      `;
      pages.push({ pageId: 'page_general_recom', isCover: false, title: 'General Recommendations', html: recomHtml });
      navItems.push({ pageId: 'page_general_recom', title: 'General Recommendations' });
    }

    // --------------------------------------------------------------------------
    // REPORT SUMMARY (DEFICIENCY ROLLUP)
    // --------------------------------------------------------------------------
    let summaryRowsHtml = '';
    if (summaryFindings.length === 0) {
      summaryRowsHtml = `<tr><td colspan="3" style="text-align: center; color: #666; padding: 1rem;">No defective or marginal conditions noted.</td></tr>`;
    } else {
      summaryFindings.forEach(f => {
        const bulletHtml = f.findings.map(b => `<div style="color: #ff0000; margin-bottom: 2px;">• ${escapeXml(b)}</div>`).join('');
        summaryRowsHtml += `
          <tr>
            <td style="font-weight: bold; width: 25%;">${escapeXml(f.section)}</td>
            <td style="width: 25%;">${escapeXml(f.itemIndex + '. ' + f.itemName)}</td>
            <td style="width: 50%;">${bulletHtml}</td>
          </tr>
        `;
      });
    }

    const summaryHtml = `
      <div class="hip-sec-title">Report Summary</div>
      <div style="font-size: 11.5px; line-height: 1.45; color: #111; margin-bottom: 12px;">
        The summary below consists of potentially significant findings. These findings can be a safety hazard, a deficiency requiring major expense to correct, or an item I would like to draw your attention to. The summary is not a substitute for the entire report. Please read the entire report carefully.
      </div>
      <table class="hip-summary-table">
        <thead>
          <tr>
            <th style="width: 25%;">Section</th>
            <th style="width: 25%;">Item</th>
            <th style="width: 50%;">Deficiency / Finding</th>
          </tr>
        </thead>
        <tbody>
          ${summaryRowsHtml}
        </tbody>
      </table>
    `;
    pages.push({ pageId: 'page_report_summary', isCover: false, title: 'Report Summary', html: summaryHtml });
    navItems.push({ pageId: 'page_report_summary', title: 'Report Summary' });

    // Store navItems globally so the dropdown can navigate
    window._hipReportNavItems = navItems;

    // Render all assembled pages with exact PDF borders, running headers, and page numbering
    const totalPages = pages.length;
    const bodyTotal = totalPages > 1 ? totalPages - 1 : 1;

    let finalHtml = '';
    pages.forEach((p, pIdx) => {
      const isCover = p.isCover;
      const bodyPage = pIdx; // Page 2 is body page 1

      const headerHtml = isCover ? '' : `
        <div class="hip-running-header">
          <div class="hip-rh-company">${escapeXml(companyName)}</div>
          <div class="hip-rh-address">${escapeXml(addressShort)}</div>
        </div>
      `;

      const footerHtml = isCover ? '' : `
        <div class="hip-running-footer">Page ${bodyPage} of ${bodyTotal}</div>
      `;

      finalHtml += `
        <div class="hip-page ${isCover ? 'hip-cover-page' : ''}" id="${p.pageId}">
          <div class="hip-page-border">
            ${headerHtml}
            <div class="hip-page-body" style="flex: 1 1 auto;">
              ${p.html}
            </div>
            ${footerHtml}
          </div>
        </div>
      `;
    });

    return finalHtml;
  }

  // Render a specific page of the PDF into the canvas preview
  async function renderPdfPage(pageNum, resetScroll = false) {
    if (!State.pdfDoc) return;
    const totalPages = State.pdfTotalPages || 1;
    pageNum = Math.max(1, Math.min(pageNum, totalPages));
    const isPageChange = (State.pdfCurrentPage !== pageNum);
    State.pdfCurrentPage = pageNum;

    const canvasScroll = document.getElementById('pdfCanvasScroll');
    const pageIndicator = document.getElementById('pdfPageIndicator');
    const btnPrev = document.getElementById('btnPdfPrevPage');
    const btnNext = document.getElementById('btnPdfNextPage');

    const zoomLevel = document.getElementById('pdfZoomLevel');
    const btnFitPage = document.getElementById('btnPdfFitPage');
    const btnFitWidth = document.getElementById('btnPdfFitWidth');

    if (pageIndicator) pageIndicator.textContent = `Page ${pageNum} / ${totalPages}`;
    if (btnPrev) btnPrev.disabled = (pageNum <= 1);
    if (btnNext) btnNext.disabled = (pageNum >= totalPages);

    if (btnFitPage) btnFitPage.classList.toggle('active', State.pdfFitMode === 'page');
    if (btnFitWidth) btnFitWidth.classList.toggle('active', State.pdfFitMode === 'width');

    if (!canvasScroll) return;

    // Cleanly cancel any in-flight render task before starting a new one
    if (State.currentRenderTask) {
      try {
        State.currentRenderTask.cancel();
      } catch (e) {}
      State.currentRenderTask = null;
    }

    try {
      const page = await State.pdfDoc.getPage(pageNum);

      // Determine dimensions from container
      const containerWidth = canvasScroll.clientWidth || 850;
      const containerHeight = canvasScroll.clientHeight || 550;
      const baseViewport = page.getViewport({ scale: 1.0 });

      const padW = containerWidth < 600 ? 12 : 40;
      const padH = containerHeight < 600 ? 12 : 40;
      const availW = Math.max(containerWidth - padW, 160);
      const availH = Math.max(containerHeight - padH, 160);
      const fitPageScale = Math.min(availW / baseViewport.width, availH / baseViewport.height);
      const fitWidthScale = availW / baseViewport.width;

      let scale;
      if (State.pdfFitMode === 'width') {
        scale = fitWidthScale;
        State.pdfCurrentScale = scale;
        if (zoomLevel) zoomLevel.textContent = 'Width';
      } else if (State.pdfFitMode === 'page') {
        scale = fitPageScale;
        State.pdfCurrentScale = scale;
        if (zoomLevel) zoomLevel.textContent = 'Fit';
      } else {
        // Custom Zoom
        if (!State.pdfCurrentScale) {
          State.pdfCurrentScale = fitPageScale;
        }
        scale = State.pdfCurrentScale;
        if (zoomLevel) {
          const pct = Math.round((scale / (fitPageScale || 1)) * 100);
          zoomLevel.textContent = `${pct}%`;
        }
      }

      const viewport = page.getViewport({ scale });

      // Clean existing page
      canvasScroll.innerHTML = '';

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-canvas-page';
      wrapper.style.width = `${Math.round(viewport.width)}px`;
      wrapper.dataset.page = pageNum;

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      canvas.style.display = 'block';

      const label = document.createElement('div');
      label.className = 'pdf-canvas-page-label';
      label.textContent = `Page ${pageNum} of ${totalPages}`;

      wrapper.appendChild(canvas);
      wrapper.appendChild(label);
      canvasScroll.appendChild(wrapper);

      if (isPageChange || resetScroll) {
        canvasScroll.scrollTop = 0;
        canvasScroll.scrollLeft = 0;
      }

      const ctx = canvas.getContext('2d');
      const renderTask = page.render({ canvasContext: ctx, viewport });
      State.currentRenderTask = renderTask;
      await renderTask.promise;
      State.currentRenderTask = null;
      if (window.lucide) lucide.createIcons();
    } catch (err) {
      if (err && (err.name === 'RenderingCancelledException' || err.message?.includes('cancelled'))) {
        return; // Ignore normal cancellation during rapid zoom or page change
      }
      console.error(`Failed to render PDF page ${pageNum}:`, err);
    }
  }

  // Load & render native PDF preview inside tabReport using PDF.js canvas
  async function loadPdfPreview(forceReload = false) {
    const tabReport = document.getElementById('tabReport');
    if (!tabReport || tabReport.style.display === 'none') {
      if (forceReload) State.pdfDirty = true;
      return;
    }

    const overlay = document.getElementById('pdfLoadingOverlay');
    const canvasViewer = document.getElementById('pdfCanvasViewer');
    const canvasScroll = document.getElementById('pdfCanvasScroll');
    const emptyState = document.getElementById('pdfEmptyState');
    const statusTag = document.getElementById('pdfPreviewStatus');
    const refreshBtn = document.getElementById('btnRefreshPdfPreview');
    const pageIndicator = document.getElementById('pdfPageIndicator');

    // Check if inspection has any content
    if (!State.sections || State.sections.length === 0) {
      if (emptyState) {
        emptyState.style.display = 'flex';
        emptyState.classList.remove('hidden');
      }
      if (canvasViewer) {
        canvasViewer.style.display = 'none';
        canvasViewer.classList.add('hidden');
      }
      if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.add('hidden');
      }
      if (statusTag) {
        statusTag.innerHTML = '<i data-lucide="info"></i><span>No Data</span>';
      }
      if (window.lucide) lucide.createIcons();
      return;
    }

    // If already generated and not dirty and not forced, reuse cached render
    if (!forceReload && !State.pdfDirty && State.cachedPdfBlobUrl && State.pdfDoc) {
      if (emptyState) {
        emptyState.style.display = 'none';
        emptyState.classList.add('hidden');
      }
      if (canvasViewer) {
        canvasViewer.style.display = 'flex';
        canvasViewer.classList.remove('hidden');
      }
      if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.add('hidden');
      }
      if (statusTag) {
        statusTag.innerHTML = '<i data-lucide="check-circle-2" style="color: var(--success, #10b981);"></i><span>Live & Synchronized</span>';
      }
      if (window.lucide) lucide.createIcons();
      return;
    }

    // Already generating? Avoid duplicate concurrent requests
    if (State.pdfIsGenerating) return;
    State.pdfIsGenerating = true;

    if (emptyState) {
      emptyState.style.display = 'none';
      emptyState.classList.add('hidden');
    }
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.classList.remove('hidden');
    }
    if (refreshBtn) refreshBtn.classList.add('is-refreshing');
    if (statusTag) {
      statusTag.innerHTML = '<i data-lucide="loader-2" class="spin"></i><span>Generating PDF...</span>';
      if (window.lucide) lucide.createIcons();
    }

    try {
      const companyName = document.getElementById('pdfCompanyName')?.value.trim() || State.clientInfo?.companyName || "N G Home Inspection Services";
      const inspectorName = document.getElementById('pdfInspectorName')?.value.trim() || State.clientInfo?.inspectorName || "Nitin Gujarathi";
      const phone = document.getElementById('pdfInspectorPhone')?.value.trim() || State.clientInfo?.inspectorPhone || "00919890002635";
      const email = document.getElementById('pdfInspectorEmail')?.value.trim() || State.clientInfo?.inspectorEmail || "niting@macj.in";
      const officeAddress = document.getElementById('pdfInspectorAddress')?.value.trim() || State.clientInfo?.inspectorAddress || "4_4 Yugaymangal complex, Kothrud, Pune, Maharashtra 411038";

      const cleanBase = (State.fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
      const pdfFilename = `${cleanBase}_Report.pdf`;

      const resp = await fetch(apiUrl('/api/export-pdf'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: pdfFilename,
          clientInfo: State.clientInfo,
          sections: State.sections,
          coverPhoto: selectedPdfCoverPhoto,
          inspectorInfo: {
            companyName,
            inspectorName,
            phone,
            email,
            officeAddress
          }
        })
      });

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.detail || `Server returned HTTP ${resp.status}`);
      }

      const blob = await resp.blob();

      // Revoke old blob to prevent memory leaks
      if (State.cachedPdfBlobUrl) {
        try { URL.revokeObjectURL(State.cachedPdfBlobUrl); } catch (_) {}
      }

      const blobUrl = URL.createObjectURL(blob);
      State.cachedPdfBlobUrl = blobUrl;
      State.pdfDirty = false;

      // Render PDF pages as canvas using PDF.js (works in ALL browsers including Brave)
      if (window.pdfjsLib && canvasScroll) {
        const loadingText = document.getElementById('pdfLoadingText');
        if (loadingText) loadingText.textContent = 'Loading vector document...';

        const arrayBuffer = await blob.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        State.pdfDoc = pdfDoc;
        State.pdfTotalPages = pdfDoc.numPages;

        if (emptyState) {
          emptyState.style.display = 'none';
          emptyState.classList.add('hidden');
        }
        if (canvasViewer) {
          canvasViewer.style.display = 'flex';
          canvasViewer.classList.remove('hidden');
        }
        await renderPdfPage(1);
        if (overlay) {
          overlay.style.display = 'none';
          overlay.classList.add('hidden');
        }

        console.log(`[PDF Preview] Successfully loaded PDF (${pdfDoc.numPages} pages) and rendered page 1`);
      } else {
        // Fallback: embed an iframe with blobUrl if PDF.js is unavailable
        let fallbackIframe = document.getElementById('pdfFallbackIframe');
        if (!fallbackIframe) {
          fallbackIframe = document.createElement('iframe');
          fallbackIframe.id = 'pdfFallbackIframe';
          fallbackIframe.className = 'pdf-viewer-frame';
          const stage = document.getElementById('pdfViewerStage');
          if (stage) stage.appendChild(fallbackIframe);
        }
        fallbackIframe.src = `${blobUrl}#toolbar=1&navpanes=1&view=FitH`;
        fallbackIframe.style.display = 'block';
        if (emptyState) {
          emptyState.style.display = 'none';
          emptyState.classList.add('hidden');
        }
        if (canvasViewer) {
          canvasViewer.style.display = 'none';
          canvasViewer.classList.add('hidden');
        }
        if (overlay) {
          overlay.style.display = 'none';
          overlay.classList.add('hidden');
        }
        console.log('[PDF Preview] Rendered via fallback iframe');
      }

      if (statusTag) {
        statusTag.innerHTML = '<i data-lucide="check-circle-2" style="color: var(--success, #10b981);"></i><span>Exact PDF Live</span>';
      }
    } catch (err) {
      console.error("PDF preview generation failed:", err);
      if (emptyState) {
        emptyState.style.display = 'flex';
        emptyState.classList.remove('hidden');
      }
      if (canvasViewer) {
        canvasViewer.style.display = 'none';
        canvasViewer.classList.add('hidden');
      }
      if (statusTag) {
        statusTag.innerHTML = '<i data-lucide="alert-triangle" style="color: var(--danger, #ef4444);"></i><span>Preview Error</span>';
      }
      showToast("PDF Preview Error: " + err.message, "error");
    } finally {
      State.pdfIsGenerating = false;
      if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.add('hidden');
      }
      if (refreshBtn) refreshBtn.classList.remove('is-refreshing');
      if (window.lucide) lucide.createIcons();
    }
  }

  async function openPdfInNewTab() {
    if (State.cachedPdfBlobUrl && !State.pdfDirty) {
      window.open(State.cachedPdfBlobUrl, '_blank');
    } else {
      await loadPdfPreview(true);
      if (State.cachedPdfBlobUrl) {
        window.open(State.cachedPdfBlobUrl, '_blank');
      }
    }
  }

  // Print entire vector PDF document (all pages)
  async function printFullPdfReport() {
    showToast("Preparing complete PDF report for printing...");
    let blobUrl = State.cachedPdfBlobUrl;
    if (!blobUrl || State.pdfDirty) {
      await loadPdfPreview(true);
      blobUrl = State.cachedPdfBlobUrl;
    }
    if (!blobUrl) {
      showToast("Unable to generate PDF for printing", "error");
      return;
    }

    let printed = false;
    let printFrame = document.getElementById('pdfPrintFrame');
    if (!printFrame) {
      printFrame = document.createElement('iframe');
      printFrame.id = 'pdfPrintFrame';
      printFrame.style.position = 'fixed';
      printFrame.style.top = '-9999px';
      printFrame.style.left = '-9999px';
      printFrame.style.width = '1px';
      printFrame.style.height = '1px';
      printFrame.style.border = 'none';
      printFrame.style.opacity = '0';
      printFrame.style.pointerEvents = 'none';
      document.body.appendChild(printFrame);
    }

    printFrame.onload = function () {
      setTimeout(() => {
        try {
          printFrame.contentWindow.focus();
          printFrame.contentWindow.print();
          printed = true;
          showToast("Print dialog launched for full PDF report");
        } catch (e) {
          console.warn("Direct iframe PDF print blocked by browser sandbox/shield:", e);
        }
      }, 500);
    };

    printFrame.src = blobUrl;

    // Browser security fallback (e.g. Brave Shields blocking PDF in iframe):
    // If iframe print does not launch within 1.8 seconds, open full PDF in dedicated print window
    setTimeout(() => {
      if (!printed) {
        const printWin = window.open(blobUrl, '_blank');
        if (printWin) {
          printWin.focus();
          setTimeout(() => {
            try { printWin.print(); } catch (_) {}
          }, 1000);
        }
        showToast("Full PDF opened in print window (Press Ctrl+P to Print)");
      }
    }, 1800);
  }

  // Trigger PDF preview or flag dirty
  function renderReport(force = false) {
    State.pdfDirty = true;
    const tabR = document.getElementById('tabReport');
    if (tabR && tabR.style.display !== 'none') {
      loadPdfPreview(force);
    }
  }

  function renderAll() {
    renderPropertyForm();
    renderSidebar();
    renderItems();
    updateMetrics();
    renderReport();
  }

  // ==========================================================================
  // LIVE INSPECTION CAMERA & CROP ENGINE
  // ==========================================================================
  let activeLiveCameraTarget = null; // { secId, itemId, replaceIdx }
  let currentCameraStream = null;
  let currentFacingMode = "environment"; // "environment" (rear camera) or "user" (front)
  let liveCameraRawImage = null; // HTMLImageElement
  let cropRotation = 0; // 0, 90, 180, 270
  let cropAspect = 4 / 3; // 4/3, 16/9, 1/1, or 'free'
  let cropCanvasScale = 1;
  let cropState = {
    rect: null, // { x, y, w, h } in display canvas coordinates
    isDragging: false,
    dragAction: null, // 'move', 'nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'
    dragStart: { x: 0, y: 0 },
    origRect: null
  };

  async function openLiveCameraModal(secId, itemId, replaceIdx = null, directDataUrl = null, optionalCaption = null) {
    const sec = State.sections.find(s => s.id === secId);
    const it = sec?.items.find(i => i.id === itemId);
    activeLiveCameraTarget = { secId, itemId, replaceIdx };

    const modal = document.getElementById('liveCameraModal');
    if (!modal) return;

    const titleEl = document.getElementById('liveCameraModalTitle');
    const subEl = document.getElementById('liveCameraModalSubtitle');
    const captionInput = document.getElementById('livePhotoCaptionInput');
    if (titleEl) titleEl.textContent = replaceIdx !== null ? "Crop / Adjust Photo" : "Live Inspection Camera";
    if (subEl) subEl.textContent = it ? `${sec.name} • ${it.name}` : "Capture defect photo";
    if (captionInput) captionInput.value = optionalCaption !== null ? optionalCaption : (it?.name || "");

    modal.style.display = 'flex';
    if (window.lucide) {
      try { lucide.createIcons(); } catch (e) {}
    }

    if (directDataUrl) {
      // Direct Crop Mode (from existing photo or external source)
      initCropEditorWithImage(directDataUrl, optionalCaption);
    } else {
      // Live Camera Viewfinder Mode
      showCameraViewfinder();
      await startCameraStream();
    }
  }

  function showCameraViewfinder() {
    const vPane = document.getElementById('cameraViewfinderPane');
    const cPane = document.getElementById('cameraCropPane');
    const btnRetake = document.getElementById('btnRetakeFromCrop');
    const btnConfirm = document.getElementById('btnConfirmPhotoCrop');
    if (vPane) vPane.style.display = 'flex';
    if (cPane) cPane.style.display = 'none';
    if (btnRetake) btnRetake.style.display = 'none';
    if (btnConfirm) btnConfirm.style.display = 'none';
  }

  function showCameraCropView(dataUrl, caption) {
    stopCameraStream();
    const vPane = document.getElementById('cameraViewfinderPane');
    const cPane = document.getElementById('cameraCropPane');
    const btnRetake = document.getElementById('btnRetakeFromCrop');
    const btnConfirm = document.getElementById('btnConfirmPhotoCrop');
    if (vPane) vPane.style.display = 'none';
    if (cPane) cPane.style.display = 'flex';
    if (btnRetake) btnRetake.style.display = 'inline-flex';
    if (btnConfirm) btnConfirm.style.display = 'inline-flex';
    initCropEditorWithImage(dataUrl, caption);
  }

  async function startCameraStream() {
    stopCameraStream();
    const loader = document.getElementById('cameraLoadingIndicator');
    const msg = document.getElementById('cameraStatusMsg');
    if (loader) loader.style.display = 'flex';
    if (msg) msg.textContent = "Connecting to device camera...";

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (loader) loader.style.display = 'flex';
      if (msg) {
        msg.innerHTML = `<strong>Direct Stream Unavailable</strong><br><span style="font-size:11px;color:#cbd5e1;">Your browser requires HTTPS for direct webcam stream.<br>Click <strong>Device App</strong> or <strong>Gallery</strong> below:</span>`;
      }
      return;
    }

    try {
      const constraints = {
        video: {
          facingMode: { ideal: currentFacingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentCameraStream = stream;
      const video = document.getElementById('liveCameraVideo');
      if (video) {
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play().catch(() => {});
          if (loader) loader.style.display = 'none';
        };
      }
    } catch (err) {
      console.warn("Camera stream error:", err);
      if (loader) loader.style.display = 'flex';
      if (msg) {
        msg.innerHTML = `<strong>Camera Blocked or Unavailable</strong><br><span style="font-size:11px;color:#cbd5e1;">Permission denied or camera in use.<br>Click <strong>Device App</strong> or <strong>Gallery</strong> below:</span>`;
      }
    }
  }

  function stopCameraStream() {
    if (currentCameraStream) {
      try {
        currentCameraStream.getTracks().forEach(t => t.stop());
      } catch (e) {}
      currentCameraStream = null;
    }
    const video = document.getElementById('liveCameraVideo');
    if (video) video.srcObject = null;
  }

  function closeLiveCameraModal() {
    stopCameraStream();
    const modal = document.getElementById('liveCameraModal');
    if (modal) modal.style.display = 'none';
    activeLiveCameraTarget = null;
    liveCameraRawImage = null;
    cropState.rect = null;
  }

  function initCropEditorWithImage(dataUrl, caption) {
    if (caption !== undefined && caption !== null) {
      const captionInput = document.getElementById('livePhotoCaptionInput');
      if (captionInput) captionInput.value = caption;
    }
    cropRotation = 0;
    cropAspect = 4 / 3;
    document.querySelectorAll('.btn-crop-ratio').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-ratio') === '4/3');
    });

    const img = new Image();
    img.onload = () => {
      liveCameraRawImage = img;
      cropState.rect = null;
      setupAndDrawCropCanvas();
    };
    img.src = dataUrl;
  }

  function getRotatedOffscreenCanvas() {
    if (!liveCameraRawImage) return null;
    const off = document.createElement('canvas');
    const rad = (cropRotation * Math.PI) / 180;
    const isSideways = cropRotation === 90 || cropRotation === 270;
    off.width = isSideways ? liveCameraRawImage.naturalHeight : liveCameraRawImage.naturalWidth;
    off.height = isSideways ? liveCameraRawImage.naturalWidth : liveCameraRawImage.naturalHeight;
    const ctx = off.getContext('2d');
    ctx.translate(off.width / 2, off.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(liveCameraRawImage, -liveCameraRawImage.naturalWidth / 2, -liveCameraRawImage.naturalHeight / 2);
    return off;
  }

  function setupAndDrawCropCanvas() {
    const off = getRotatedOffscreenCanvas();
    if (!off) return;

    const canvas = document.getElementById('cropCanvas');
    const wrapper = document.getElementById('cropCanvasWrapper');
    if (!canvas || !wrapper) return;

    const maxW = Math.max(260, Math.min(wrapper.clientWidth || 560, window.innerWidth - 60));
    const maxH = Math.max(200, Math.min(wrapper.clientHeight || 360, window.innerHeight * 0.46));
    const scale = Math.min(maxW / off.width, maxH / off.height, 1);

    canvas.width = Math.max(100, Math.round(off.width * scale));
    canvas.height = Math.max(100, Math.round(off.height * scale));
    cropCanvasScale = scale;

    const ctx = canvas.getContext('2d');

    // Calculate crop rectangle if not set
    if (!cropState.rect || cropState.rect.w === 0) {
      let rw = Math.round(canvas.width * 0.88);
      let rh;
      if (cropAspect === 'free' || !cropAspect) {
        rh = Math.round(canvas.height * 0.88);
      } else {
        rh = Math.round(rw / cropAspect);
        if (rh > canvas.height * 0.95) {
          rh = Math.round(canvas.height * 0.95);
          rw = Math.round(rh * cropAspect);
        }
      }
      cropState.rect = {
        x: Math.max(0, Math.round((canvas.width - rw) / 2)),
        y: Math.max(0, Math.round((canvas.height - rh) / 2)),
        w: Math.min(canvas.width, rw),
        h: Math.min(canvas.height, rh)
      };
    } else {
      // Clamp within canvas boundaries
      cropState.rect.x = Math.max(0, Math.min(canvas.width - 30, cropState.rect.x));
      cropState.rect.y = Math.max(0, Math.min(canvas.height - 30, cropState.rect.y));
      cropState.rect.w = Math.min(canvas.width - cropState.rect.x, cropState.rect.w);
      cropState.rect.h = Math.min(canvas.height - cropState.rect.y, cropState.rect.h);
    }

    // Draw rotated image scaled onto canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    const r = cropState.rect;

    // Darkened Overlay outside crop area
    ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
    ctx.fillRect(0, 0, canvas.width, r.y); // Top
    ctx.fillRect(0, r.y + r.h, canvas.width, canvas.height - (r.y + r.h)); // Bottom
    ctx.fillRect(0, r.y, r.x, r.h); // Left
    ctx.fillRect(r.x + r.w, r.y, canvas.width - (r.x + r.w), r.h); // Right

    // Crop Outline
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Rule of thirds lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.x + r.w / 3, r.y); ctx.lineTo(r.x + r.w / 3, r.y + r.h);
    ctx.moveTo(r.x + (r.w * 2) / 3, r.y); ctx.lineTo(r.x + (r.w * 2) / 3, r.y + r.h);
    ctx.moveTo(r.x, r.y + r.h / 3); ctx.lineTo(r.x + r.w, r.y + r.h / 3);
    ctx.moveTo(r.x, r.y + (r.h * 2) / 3); ctx.lineTo(r.x + r.w, r.y + (r.h * 2) / 3);
    ctx.stroke();

    // 8 Drag Handles (4 Corners + 4 Edge Midpoints)
    const handles = [
      { x: r.x, y: r.y }, // NW
      { x: r.x + r.w, y: r.y }, // NE
      { x: r.x, y: r.y + r.h }, // SW
      { x: r.x + r.w, y: r.y + r.h }, // SE
      { x: r.x + r.w / 2, y: r.y }, // N
      { x: r.x + r.w / 2, y: r.y + r.h }, // S
      { x: r.x, y: r.y + r.h / 2 }, // W
      { x: r.x + r.w, y: r.y + r.h / 2 }, // E
    ];
    handles.forEach(h => {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(h.x, h.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  function getCanvasTouchPos(canvas, e) {
    const bbox = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : (e.changedTouches ? e.changedTouches[0] : e);
    return {
      x: (touch.clientX - bbox.left) * (canvas.width / bbox.width),
      y: (touch.clientY - bbox.top) * (canvas.height / bbox.height)
    };
  }

  function getCropDragAction(pos) {
    if (!cropState.rect) return null;
    const r = cropState.rect;
    const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);

    if (dist(pos.x, pos.y, r.x, r.y) <= 18) return 'nw';
    if (dist(pos.x, pos.y, r.x + r.w, r.y) <= 18) return 'ne';
    if (dist(pos.x, pos.y, r.x, r.y + r.h) <= 18) return 'sw';
    if (dist(pos.x, pos.y, r.x + r.w, r.y + r.h) <= 18) return 'se';

    if (dist(pos.x, pos.y, r.x + r.w / 2, r.y) <= 14) return 'n';
    if (dist(pos.x, pos.y, r.x + r.w / 2, r.y + r.h) <= 14) return 's';
    if (dist(pos.x, pos.y, r.x, r.y + r.h / 2) <= 14) return 'w';
    if (dist(pos.x, pos.y, r.x + r.w, r.y + r.h / 2) <= 14) return 'e';

    if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) {
      return 'move';
    }
    return null;
  }

  function handleCropPointerDown(pos) {
    const action = getCropDragAction(pos);
    if (!action) return;
    cropState.isDragging = true;
    cropState.dragAction = action;
    cropState.dragStart = { x: pos.x, y: pos.y };
    cropState.origRect = { ...cropState.rect };
  }

  function handleCropPointerMove(pos, canvas) {
    if (!cropState.isDragging || !cropState.origRect) {
      const action = getCropDragAction(pos);
      if (action === 'nw' || action === 'se') canvas.style.cursor = 'nwse-resize';
      else if (action === 'ne' || action === 'sw') canvas.style.cursor = 'nesw-resize';
      else if (action === 'n' || action === 's') canvas.style.cursor = 'ns-resize';
      else if (action === 'w' || action === 'e') canvas.style.cursor = 'ew-resize';
      else if (action === 'move') canvas.style.cursor = 'move';
      else canvas.style.cursor = 'crosshair';
      return;
    }

    const dx = pos.x - cropState.dragStart.x;
    const dy = pos.y - cropState.dragStart.y;
    const orig = cropState.origRect;
    const minSize = 35;

    if (cropState.dragAction === 'move') {
      const newX = Math.max(0, Math.min(canvas.width - orig.w, orig.x + dx));
      const newY = Math.max(0, Math.min(canvas.height - orig.h, orig.y + dy));
      cropState.rect.x = Math.round(newX);
      cropState.rect.y = Math.round(newY);
    } else if (cropState.dragAction === 'se') {
      let newW = Math.max(minSize, Math.min(canvas.width - orig.x, orig.w + dx));
      let newH = cropAspect && cropAspect !== 'free' ? newW / cropAspect : Math.max(minSize, Math.min(canvas.height - orig.y, orig.h + dy));
      if (orig.y + newH > canvas.height) {
        newH = canvas.height - orig.y;
        if (cropAspect && cropAspect !== 'free') newW = newH * cropAspect;
      }
      cropState.rect.w = Math.round(newW);
      cropState.rect.h = Math.round(newH);
    } else if (cropState.dragAction === 'sw') {
      let newW = Math.max(minSize, Math.min(orig.x + orig.w, orig.w - dx));
      let newH = cropAspect && cropAspect !== 'free' ? newW / cropAspect : Math.max(minSize, Math.min(canvas.height - orig.y, orig.h + dy));
      if (orig.y + newH > canvas.height) {
        newH = canvas.height - orig.y;
        if (cropAspect && cropAspect !== 'free') newW = newH * cropAspect;
      }
      cropState.rect.x = Math.round(orig.x + (orig.w - newW));
      cropState.rect.w = Math.round(newW);
      cropState.rect.h = Math.round(newH);
    } else if (cropState.dragAction === 'ne') {
      let newW = Math.max(minSize, Math.min(canvas.width - orig.x, orig.w + dx));
      let newH = cropAspect && cropAspect !== 'free' ? newW / cropAspect : Math.max(minSize, orig.h - dy);
      let newY = orig.y + (orig.h - newH);
      if (newY < 0) {
        newY = 0;
        newH = orig.y + orig.h;
        if (cropAspect && cropAspect !== 'free') newW = newH * cropAspect;
      }
      cropState.rect.y = Math.round(newY);
      cropState.rect.w = Math.round(newW);
      cropState.rect.h = Math.round(newH);
    } else if (cropState.dragAction === 'nw') {
      let newW = Math.max(minSize, Math.min(orig.x + orig.w, orig.w - dx));
      let newH = cropAspect && cropAspect !== 'free' ? newW / cropAspect : Math.max(minSize, orig.h - dy);
      let newX = orig.x + (orig.w - newW);
      let newY = orig.y + (orig.h - newH);
      if (newX < 0) newX = 0;
      if (newY < 0) {
        newY = 0;
        newH = orig.y + orig.h;
        if (cropAspect && cropAspect !== 'free') {
          newW = newH * cropAspect;
          newX = orig.x + orig.w - newW;
        }
      }
      cropState.rect.x = Math.round(newX);
      cropState.rect.y = Math.round(newY);
      cropState.rect.w = Math.round(newW);
      cropState.rect.h = Math.round(newH);
    }
    setupAndDrawCropCanvas();
  }

  function handleCropPointerUp() {
    cropState.isDragging = false;
    cropState.dragAction = null;
    cropState.origRect = null;
  }

  function saveCroppedPhotoToItem() {
    if (!activeLiveCameraTarget || !cropState.rect) return;
    const off = getRotatedOffscreenCanvas();
    if (!off) return;

    const sx = Math.max(0, Math.round(cropState.rect.x / cropCanvasScale));
    const sy = Math.max(0, Math.round(cropState.rect.y / cropCanvasScale));
    const sw = Math.min(off.width - sx, Math.round(cropState.rect.w / cropCanvasScale));
    const sh = Math.min(off.height - sy, Math.round(cropState.rect.h / cropCanvasScale));

    const maxOut = 1600;
    const outScale = Math.min(maxOut / sw, maxOut / sh, 1);
    const outW = Math.round(sw * outScale);
    const outH = Math.round(sh * outScale);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = Math.max(1, outW);
    outCanvas.height = Math.max(1, outH);
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(off, sx, sy, sw, sh, 0, 0, outW, outH);
    const croppedDataUrl = outCanvas.toDataURL('image/jpeg', 0.88);

    const { secId, itemId, replaceIdx } = activeLiveCameraTarget;
    const sec = State.sections.find(s => s.id === secId);
    const it = sec?.items.find(i => i.id === itemId);
    if (it) {
      if (!it.photos) it.photos = [];
      const captionText = document.getElementById('livePhotoCaptionInput')?.value.trim() || it.name;
      if (replaceIdx !== null && replaceIdx !== undefined && it.photos[replaceIdx]) {
        it.photos[replaceIdx].dataUrl = croppedDataUrl;
        it.photos[replaceIdx].caption = captionText;
        showToast(`Photo updated on ${it.name}`);
      } else {
        it.photos.push({
          filename: `photo_${Date.now()}_camera.jpg`,
          dataUrl: croppedDataUrl,
          caption: captionText
        });
        showToast(`Live photo added to ${it.name}`);
      }
      State.isDirty = true;
      renderItems();
      renderReport();
      saveActiveSession();
    }
    closeLiveCameraModal();
  }

  // Public App Handlers
  window.App = {
    openLiveCamera: function (secId, itemId) {
      openLiveCameraModal(secId, itemId);
    },
    setStatus: function (secId, itemId, status) {
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it) {
        it.status = status;
        State.isDirty = true;
        renderItems();
        updateMetrics();
        renderSidebar();
        renderReport();
        saveActiveSession();
      }
    },

    setComments: function (secId, itemId, comments) {
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it) {
        it.comments = comments;
        State.isDirty = true;
        renderReport();
        debouncedSaveSession();
      }
    },

    uploadPhoto: function (secId, itemId, input) {
      if (!input.files || !input.files[0]) return;
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = function (e) {
        const sec = State.sections.find(s => s.id === secId);
        const it = sec?.items.find(i => i.id === itemId);
        if (it) {
          if (!it.photos) it.photos = [];
          it.photos.push({
            filename: `photo_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '')}`,
            dataUrl: e.target.result,
            caption: it.name
          });
          State.isDirty = true;
          renderItems();
          renderReport();
          saveActiveSession();
          showToast("Photo attached");
        }
      };
      reader.readAsDataURL(file);
    },

    openPhoto: function (secId, itemId, pIdx) {
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      const photo = it?.photos[pIdx];
      if (!photo) return;

      State.activePhotoTarget = { secId, itemId, pIdx };
      document.getElementById('photoModalImg').src = photo.dataUrl;
      document.getElementById('photoModalCaption').value = photo.caption || '';
      document.getElementById('photoModalTitle').textContent = `${sec.name} • ${it.name}`;
      document.getElementById('photoModal').style.display = 'flex';
    },

    openSaved: async function (reportId) {
      try {
        const resp = await fetch(apiUrl(`/api/reports/${reportId}`));
        if (resp.ok) {
          const json = await resp.json();
          if (json.success && json.data) {
            State.activeReportId = reportId;
            State.fileName = json.data.fileName || "Inspection_Report.hzf";
            State.clientInfo = json.data.clientInfo || {};
            State.sections = json.data.sections || [];
            State.activeSectionId = State.sections[0] ? State.sections[0].id : null;
            State.isDirty = false;
            document.getElementById('savedReportsModal').style.display = 'none';
            setWorkspaceActive(true);
            saveActiveSession();
            showToast(`Loaded ${State.fileName}`);
            return;
          }
        }
      } catch (e) {
        showToast("Error opening report: " + e.message);
      }
    },

    downloadSaved: async function (reportId, format) {
      try {
        const resp = await fetch(apiUrl(`/api/reports/${reportId}`));
        if (resp.ok) {
          const json = await resp.json();
          if (json.success && json.data) {
            if (format === 'pdf') {
              showToast("Generating PDF for " + (json.data.fileName || 'Report') + "...");
              const cleanBase = (json.data.fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
              const pdfFilename = `${cleanBase}_Report.pdf`;
              const respPdf = await fetch(apiUrl('/api/export-pdf'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: reportId,
                  fileName: pdfFilename,
                  clientInfo: json.data.clientInfo || {},
                  sections: json.data.sections || [],
                  coverPhoto: null,
                  inspectorInfo: {
                    companyName: json.data.clientInfo?.companyName || "N G Home Inspection Services",
                    inspectorName: json.data.clientInfo?.inspectorName || "Nitin Gujarathi",
                    phone: json.data.clientInfo?.inspectorPhone || "00919890002635",
                    email: json.data.clientInfo?.inspectorEmail || "niting@macj.in",
                    officeAddress: json.data.clientInfo?.inspectorAddress || "4_4 Yugaymangal complex, Kothrud, Pune, Maharashtra 411038"
                  }
                })
              });
              if (respPdf.ok) {
                const blob = await respPdf.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = pdfFilename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                  try {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  } catch (_) {}
                }, 60000);
                showToast(`Downloaded ${pdfFilename}!`);
              } else {
                showToast("Failed to generate PDF for saved report");
              }
              return;
            }
            const endpoint = (format === 'bin') ? '/api/export-bin' : '/api/export-hzf';
            const dlResp = await fetch(apiUrl(endpoint), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(json.data)
            });
            if (dlResp.ok) {
              const blob = await dlResp.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.style.display = 'none';
              a.href = url;
              a.download = (json.data.fileName || 'Report').replace(/\.[^/.]+$/, "") + '.' + format;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => {
                try {
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                } catch (_) {}
              }, 60000);
              showToast(`Downloaded .${format}!`);
            } else {
              showToast(`Failed to export .${format} from server`);
            }
          }
        }
      } catch (e) {
        showToast("Download failed: " + e.message);
      }
    },

    deleteSaved: async function (reportId) {
      if (!confirm("Are you sure you want to delete this saved report?")) return;
      try {
        const resp = await fetch(apiUrl(`/api/reports/${reportId}`), { method: 'DELETE' });
        if (resp.ok) {
          showToast("Report deleted");
          loadSavedReportsModal();
          refreshSavedReportsCount();
        }
      } catch (e) {
        showToast("Error: " + e.message);
      }
    },

    // Polish a single item's field note or inspect attached photos using Gemini Vision
    polishItem: async function (secId, itemId) {
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (!it) return;

      const raw = (it.comments || '').trim();
      const photos = it.photos || [];
      const hasPhotos = photos.length > 0;

      if (!raw && !hasPhotos) {
        showToast("Please enter an inspector note or attach a photo first.");
        return;
      }

      if (hasPhotos && !raw) {
        showToast("🔍 AI inspecting photo(s) & generating narrative...");
      } else if (hasPhotos && raw) {
        showToast("✨ AI inspecting photo(s) & polishing narrative...");
      } else {
        showToast("✨ AI polishing narrative...");
      }

      try {
        const resp = await fetch(apiUrl('/api/ai/polish-item'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sectionName: sec.name,
            itemName: it.name,
            status: it.status,
            rawComments: raw,
            photosCount: photos.length,
            photos: photos.slice(0, 3).map(p => ({
              filename: p.filename,
              dataUrl: p.dataUrl,
              caption: p.caption
            }))
          })
        });

        if (resp.ok) {
          const res = await resp.json();
          if (res.success && res.polished) {
            it.comments = res.polished;
            if (res.recommendedStatus && res.recommendedStatus !== 'Inconclusive') {
              it.status = res.recommendedStatus;
            }
            if (res.photoCaption && it.photos && it.photos.length > 0) {
              if (!it.photos[0].caption || it.photos[0].caption === it.name) {
                it.photos[0].caption = res.photoCaption;
              }
            }
            State.isDirty = true;
            renderItems();
            updateMetrics();
            renderReport();
            saveActiveSession();
            if (hasPhotos && !raw) {
              showToast("✨ AI inspected photo & filled observation narrative!");
            } else {
              showToast("✨ Narrative polished with InterNACHI standards!");
            }
            return;
          } else if (res.error) {
            showToast(res.error);
            return;
          }
        }
        showToast("AI response received but could not format.");
      } catch (err) {
        showToast("AI Polish error: " + err.message);
      }
    },

    // Jump directly to an item from the QA audit scorecard
    jumpToItem: function (secId, itemId) {
      if (secId) {
        State.activeSectionId = secId;
        renderSidebar();
        renderItems();
      }
      const modal = document.getElementById('qaAuditModal');
      if (modal) modal.style.display = 'none';

      setTimeout(() => {
        const el = document.getElementById(`notes_${itemId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();
          el.style.borderColor = '#6366f1';
          el.style.boxShadow = '0 0 10px rgba(99, 102, 241, 0.4)';
          setTimeout(() => {
            el.style.borderColor = '';
            el.style.boxShadow = '';
          }, 2000);
        }
      }, 150);
    }
  };

  // Cached suggestions for batch narrative review
  let currentBatchSuggestions = {};

  // Check Gemini AI Status
  async function checkAiConnection() {
    const dot = document.getElementById('aiStatusDot');
    const drawerDot = document.getElementById('drawerAiStatusDot');
    const modalDot = document.getElementById('modalAiDot');
    const modalMsg = document.getElementById('modalAiStatusMsg');

    try {
      const resp = await fetch(apiUrl('/api/ai/status'));
      if (resp.ok) {
        const data = await resp.json();
        if (data.success && data.configured) {
          if (dot) {
            dot.className = 'ai-status-indicator connected';
            dot.title = `Gemini AI Connected (${data.model || 'Flash'})`;
          }
          if (drawerDot) {
            drawerDot.className = 'ai-status-indicator connected';
            drawerDot.title = `Gemini AI Connected (${data.model || 'Flash'})`;
          }
          if (modalDot) modalDot.className = 'status-dot connected';
          if (modalMsg) modalMsg.textContent = `Connected to Google Gemini AI (${data.model || 'Flash'})`;
          return true;
        } else {
          if (dot) {
            dot.className = 'ai-status-indicator';
            dot.title = 'Gemini API Key Needed';
          }
          if (drawerDot) {
            drawerDot.className = 'ai-status-indicator';
            drawerDot.title = 'Gemini API Key Needed';
          }
          if (modalDot) modalDot.className = 'status-dot error';
          if (modalMsg) modalMsg.textContent = data.message || 'API key not configured in .env';
          return false;
        }
      }
    } catch (e) {
      if (dot) dot.className = 'ai-status-indicator';
      if (drawerDot) drawerDot.className = 'ai-status-indicator';
      if (modalMsg) modalMsg.textContent = 'Backend offline or unreachable';
    }
    return false;
  }

  // Run QA Compliance Audit
  async function runQaAudit() {
    syncFormToState();
    showToast("🛡️ Running QA Compliance Audit...");

    try {
      const resp = await fetch(apiUrl('/api/qa/audit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: State.fileName,
          clientInfo: State.clientInfo,
          sections: State.sections
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.success) {
          // Update Score Chip in Hero
          const chipScore = document.getElementById('countQaScore');
          if (chipScore) chipScore.textContent = `${data.qaScore}%`;

          // Populate QA Modal
          const modalScoreNum = document.getElementById('modalQaScoreNum');
          if (modalScoreNum) modalScoreNum.textContent = data.qaScore;

          const titleEl = document.getElementById('qaVerdictTitle');
          const descEl = document.getElementById('qaVerdictDesc');
          if (data.isApproved) {
            if (titleEl) titleEl.textContent = "✅ Report Compliant & Ready";
            if (descEl) descEl.textContent = "No critical omissions or missing photographic evidence detected.";
          } else {
            if (titleEl) titleEl.textContent = "⚠️ Review Action Items Required";
            if (descEl) descEl.textContent = "Address the flagged items below before issuing the final client report.";
          }

          const stats = data.statistics || {};
          document.getElementById('qaCountHigh').textContent = `${stats.highIssues || 0} Critical`;
          document.getElementById('qaCountMed').textContent = `${stats.mediumIssues || 0} Warnings`;
          document.getElementById('qaCountLow').textContent = `${stats.lowIssues || 0} Notices`;

          const listEl = document.getElementById('qaIssuesList');
          if (listEl) {
            listEl.innerHTML = '';
            if (!data.issues || data.issues.length === 0) {
              listEl.innerHTML = `<div style="text-align: center; padding: 1.5rem; color: #10b981; font-weight: 600;">🎉 Perfect score! No audit issues found.</div>`;
            } else {
              data.issues.forEach(iss => {
                const itemDiv = document.createElement('div');
                itemDiv.className = `qa-issue-item ${iss.severity}`;
                itemDiv.innerHTML = `
                  <div class="qa-issue-content">
                    <h5>${iss.title}</h5>
                    <p>${iss.message}</p>
                  </div>
                  ${iss.itemId ? `<button class="btn btn-outline btn-sm" onclick="window.App.jumpToItem('${iss.sectionId}', '${iss.itemId}')">Jump to Item</button>` : ''}
                `;
                listEl.appendChild(itemDiv);
              });
            }
          }

          document.getElementById('qaAuditModal').style.display = 'flex';
          return;
        }
      }
      showToast("QA audit failed to complete.");
    } catch (err) {
      showToast("QA error: " + err.message);
    }
  }

  // Run Batch Narrative Polish
  async function runBatchPolish() {
    syncFormToState();
    showToast("✨ AI expanding & polishing field notes...");

    try {
      const resp = await fetch(apiUrl('/api/ai/batch-polish'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: State.fileName,
          clientInfo: State.clientInfo,
          sections: State.sections
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.success) {
          if (!data.results || Object.keys(data.results).length === 0) {
            showToast(data.message || "No items needed polishing.");
            return;
          }

          currentBatchSuggestions = data.results;
          const stream = document.getElementById('aiDiffStream');
          if (stream) {
            stream.innerHTML = '';

            for (const sec of State.sections) {
              for (const it of (sec.items || [])) {
                const sug = currentBatchSuggestions[it.id];
                if (sug) {
                  const card = document.createElement('div');
                  card.className = 'ai-diff-card';
                  card.innerHTML = `
                    <div class="ai-diff-header">
                      <span>${sec.name} &bull; ${it.name}</span>
                      <div class="diff-tags">
                        <span class="badge-stat stat-low">${sug.trade || 'General'}</span>
                        <span class="badge-stat stat-high">${sug.recommendedStatus || it.status}</span>
                      </div>
                    </div>
                    <div class="ai-diff-grid">
                      <div class="diff-col">
                        <label>Original Mobile Field Note</label>
                        <div class="diff-box original">${it.comments || '<i>(No notes)</i>'}</div>
                      </div>
                      <div class="diff-col">
                        <label>AI Enhanced Narrative (InterNACHI)</label>
                        <div class="diff-box polished">${sug.polishedComments}</div>
                      </div>
                    </div>
                  `;
                  stream.appendChild(card);
                }
              }
            }
          }

          document.getElementById('aiBatchReviewModal').style.display = 'flex';
          return;
        } else if (data.error) {
          showToast(data.error);
          return;
        }
      }
      showToast("Could not complete AI batch polish.");
    } catch (err) {
      showToast("AI batch error: " + err.message);
    }
  }

  // Generate Executive Summary
  async function runExecutiveSummary() {
    syncFormToState();
    showToast("📋 Generating Executive Defect Summary...");

    try {
      const resp = await fetch(apiUrl('/api/ai/summary'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: State.fileName,
          clientInfo: State.clientInfo,
          sections: State.sections
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.success && data.summary) {
          const s = data.summary;
          const container = document.getElementById('aiSummaryContent');
          if (container) {
            container.innerHTML = `
              <div class="summary-section-box">
                <h4><i data-lucide="info" style="color: var(--accent); width: 16px; height: 16px;"></i> Overall Property Assessment</h4>
                <p style="font-size: 0.9rem; line-height: 1.5; color: var(--text-main);">${s.overallAssessment || 'No overview generated.'}</p>
              </div>

              <div class="summary-section-box" style="border-left: 4px solid var(--hazard-color);">
                <h4 style="color: var(--hazard-color);"><i data-lucide="alert-triangle" style="width: 16px; height: 16px;"></i> Immediate Safety Concerns</h4>
                <ul>
                  ${(s.immediateSafetyHazards || []).map(h => `<li>${h}</li>`).join('') || '<li>None identified.</li>'}
                </ul>
              </div>

              <div class="summary-section-box" style="border-left: 4px solid var(--defect-color);">
                <h4 style="color: var(--defect-color);"><i data-lucide="alert-circle" style="width: 16px; height: 16px;"></i> Major Deficiencies & Repairs</h4>
                <ul>
                  ${(s.majorDefects || []).map(d => `<li>${d}</li>`).join('') || '<li>None identified.</li>'}
                </ul>
              </div>

              <div class="summary-section-box">
                <h4><i data-lucide="wrench" style="color: #6366f1; width: 16px; height: 16px;"></i> Recommended Professional Trades</h4>
                <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.4rem;">
                  ${(s.recommendedContractors || []).map(c => `<span class="badge-stat stat-low" style="background:#eef2ff; color:#4338ca; border-color:#c7d2fe;">${c}</span>`).join('')}
                </div>
              </div>
            `;
            if (window.lucide) lucide.createIcons();
          }

          document.getElementById('aiSummaryModal').style.display = 'flex';
          return;
        } else if (data.error) {
          showToast(data.error);
          return;
        }
      }
      showToast("Failed to generate summary.");
    } catch (err) {
      showToast("Summary error: " + err.message);
    }
  }

  // ==============================================================================
  // VISUAL PDF REPORT EXPORT & COVER PHOTO SELECTOR (Matching Mantra Mirari Standard)
  // ==============================================================================
  selectedPdfCoverPhoto = null; // Base64 dataUrl or null (for default)
  let selectedCoverSourceType = 'default'; // 'default', 'upload', 'report'

  // Open Export PDF Modal and populate cover photo selector & inspector details
  function openExportPdfModal() {
    syncFormToState();
    const modal = document.getElementById('exportPdfModal');
    if (!modal) return;

    // 1. Populate Inspector & Company Details
    const c = State.clientInfo || {};
    const companyInput = document.getElementById('pdfCompanyName');
    const inspNameInput = document.getElementById('pdfInspectorName');
    const phoneInput = document.getElementById('pdfInspectorPhone');
    const emailInput = document.getElementById('pdfInspectorEmail');
    const addrInput = document.getElementById('pdfInspectorAddress');

    if (companyInput) companyInput.value = c.inspectionCompany || "N G Home Inspection Services";
    if (inspNameInput) inspNameInput.value = c.inspectorName || "Nitin Gujarathi";
    if (phoneInput) phoneInput.value = c.clientPhone || "00919890002635";
    if (emailInput) emailInput.value = c.clientEmail || "niting@macj.in";
    if (addrInput) addrInput.value = "4_4 Yugaymangal complex, Kothrud, Pune, Maharashtra 411038";

    // 2. Collect all attached photos from all sections
    const allReportPhotos = [];
    (State.sections || []).forEach(s => {
      (s.items || []).forEach(it => {
        (it.photos || []).forEach(p => {
          if (p.dataUrl) {
            allReportPhotos.push({
              sectionName: s.name,
              itemName: it.name,
              caption: p.caption || it.name,
              dataUrl: p.dataUrl
            });
          }
        });
      });
    });

    const countElem = document.getElementById('reportPhotosCount');
    if (countElem) countElem.textContent = allReportPhotos.length;

    // Render photo gallery drawer thumbnails
    const grid = document.getElementById('reportPhotosGrid');
    if (grid) {
      grid.innerHTML = '';
      if (allReportPhotos.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 1rem;">No photos attached to items in this inspection yet.</div>';
      } else {
        allReportPhotos.forEach((photo) => {
          const card = document.createElement('div');
          card.className = 'report-thumb-card' + (selectedPdfCoverPhoto === photo.dataUrl ? ' selected' : '');
          card.title = `${photo.sectionName} - ${photo.itemName}`;
          card.innerHTML = `
            <img src="${photo.dataUrl}" alt="Thumbnail" />
            <div class="report-thumb-badge">${escapeXml(photo.caption || photo.itemName)}</div>
          `;
          card.addEventListener('click', () => {
            document.querySelectorAll('.report-thumb-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            setCoverPhoto(photo.dataUrl, 'report', `${photo.sectionName}: ${photo.caption || photo.itemName}`);
          });
          grid.appendChild(card);
        });
      }
    }

    // Initialize Cover Photo preview
    if (!selectedPdfCoverPhoto) {
      if (allReportPhotos.length > 0) {
        setCoverPhoto(allReportPhotos[0].dataUrl, 'report', `Photo 1: ${allReportPhotos[0].caption || 'Exterior'}`);
      } else {
        setCoverPhoto(null, 'default', 'Default Bundled Hero');
      }
    } else {
      updateCoverPreviewUI();
    }

    const drawer = document.getElementById('reportPhotosDrawer');
    if (drawer) drawer.style.display = 'none';

    const overlay = document.getElementById('pdfGeneratingOverlay');
    if (overlay) overlay.style.display = 'none';

    modal.style.display = 'flex';
    if (window.lucide) lucide.createIcons();
  }

  function setCoverPhoto(dataUrl, sourceType, sourceLabel) {
    selectedPdfCoverPhoto = dataUrl;
    selectedCoverSourceType = sourceType;
    const labelElem = document.getElementById('coverSourceLabel');
    if (labelElem) labelElem.textContent = sourceLabel || (sourceType === 'upload' ? 'Custom Uploaded Photo' : (sourceType === 'report' ? 'Selected Report Photo' : 'Default Bundled Hero'));
    updateCoverPreviewUI();
  }

  function updateCoverPreviewUI() {
    const img = document.getElementById('pdfCoverPreviewImg');
    const placeholder = document.getElementById('pdfCoverPlaceholder');
    if (selectedPdfCoverPhoto) {
      if (img) {
        img.src = selectedPdfCoverPhoto;
        img.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
    } else {
      if (img) {
        img.src = '';
        img.style.display = 'none';
      }
      if (placeholder) placeholder.style.display = 'flex';
    }
  }

  // Trigger Backend PDF Generator and stream download
  async function submitGeneratePdf() {
    syncFormToState();
    const overlay = document.getElementById('pdfGeneratingOverlay');
    const statusTxt = document.getElementById('pdfGeneratingStatus');
    const submitBtn = document.getElementById('btnSubmitGeneratePdf');
    const cancelBtn = document.getElementById('btnCancelExportPdf');

    const originalBtnHtml = submitBtn ? submitBtn.innerHTML : '';

    if (overlay) overlay.style.display = 'flex';
    if (statusTxt) statusTxt.textContent = "Compiling report and formatting high-res photos...";

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-sm" style="margin-right: 6px;"></span><span>Generating PDF...</span>';
    }
    if (cancelBtn) cancelBtn.disabled = true;

    const companyName = document.getElementById('pdfCompanyName')?.value.trim() || "N G Home Inspection Services";
    const inspectorName = document.getElementById('pdfInspectorName')?.value.trim() || "Nitin Gujarathi";
    const phone = document.getElementById('pdfInspectorPhone')?.value.trim() || "00919890002635";
    const email = document.getElementById('pdfInspectorEmail')?.value.trim() || "niting@macj.in";
    const officeAddress = document.getElementById('pdfInspectorAddress')?.value.trim() || "4_4 Yugaymangal complex, Kothrud, Pune, Maharashtra 411038";

    const cleanBase = (State.fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
    const pdfFilename = `${cleanBase}_Report.pdf`;

    try {
      const resp = await fetch(apiUrl('/api/export-pdf'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: pdfFilename,
          clientInfo: State.clientInfo,
          sections: State.sections,
          coverPhoto: selectedPdfCoverPhoto,
          inspectorInfo: {
            companyName: companyName,
            inspectorName: inspectorName,
            phone: phone,
            email: email,
            officeAddress: officeAddress
          }
        })
      });

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.detail || `Server returned HTTP ${resp.status}`);
      }

      if (statusTxt) statusTxt.textContent = "Downloading PDF to your computer...";
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pdfFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const modal = document.getElementById('exportPdfModal');
      if (modal) modal.style.display = 'none';
      showToast(`🎉 Downloaded ${pdfFilename}!`);
    } catch (err) {
      alert("PDF Generation Failed: " + err.message);
    } finally {
      if (overlay) overlay.style.display = 'none';
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHtml;
        if (window.lucide) lucide.createIcons();
      }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  }

  function downloadPdfReport() {
    openExportPdfModal();
  }

  // Fast Export for .hzf and .bin containers
  async function exportFile(format) {
    showToast(`Preparing .${format} package...`);
    syncFormToState();
    const cleanBase = (State.fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
    const downloadName = `${cleanBase}.${format}`;

    // Ensure all photo data is hydrated from IndexedDB if not already in memory
    const missingPhotos = [];
    for (const sec of (State.sections || [])) {
      for (const it of (sec.items || [])) {
        for (const p of (it.photos || [])) {
          if (p.filename && !p.dataUrl) {
            missingPhotos.push(p.filename);
          }
        }
      }
    }
    if (missingPhotos.length > 0) {
      try {
        showToast(`Loading photos for .${format} package...`);
        const photoMap = await idbGetPhotos(missingPhotos);
        for (const sec of (State.sections || [])) {
          for (const it of (sec.items || [])) {
            for (const p of (it.photos || [])) {
              if (p.filename && !p.dataUrl && photoMap[p.filename]) {
                p.dataUrl = photoMap[p.filename];
              }
            }
          }
        }
      } catch (e) {
        console.warn("Could not hydrate photos before export:", e);
      }
    }

    // Client-side instant zip packaging with STORE compression (no CPU freeze)
    if (window.JSZip) {
      try {
        const zip = new JSZip();

        // 1. ClientInfo.xml (Java XMLDecoder structure)
        let clientXml = `<?xml version="1.0" encoding="UTF-8"?>\n<java version="1.8.0_131" class="java.beans.XMLDecoder">\n<object class="homeinspectorpro.ClientInfo">\n`;
        const cMap = {
          clientName: 'firstName',
          clientPhone: 'phone',
          clientEmail: 'email',
          inspectionAddress: 'address',
          inspectorName: 'inspectorName',
          inspectionCompany: 'company',
          inspectorLicense: 'license',
          inspectionDate: 'inspectionDate',
          inspectionTime: 'inspectionTime',
          weather: 'weather',
          propertyType: 'otherInfo',
          yearBuilt: 'yearBuilt',
          squareFootage: 'squareFootage'
        };
        for (const [k, prop] of Object.entries(cMap)) {
          if (State.clientInfo && State.clientInfo[k]) {
            clientXml += `  <void property="${prop}"><string>${escapeXml(State.clientInfo[k])}</string></void>\n`;
          }
        }
        clientXml += `</object>\n</java>`;
        zip.file("ClientInfo.xml", clientXml);

        // 2. TabbedPanes.tpl
        let tplXml = `<?xml version="1.0" encoding="UTF-8"?>\n<java version="1.8.0_131" class="java.beans.XMLDecoder">\n<object class="homeinspectorpro.TemplateInfo">\n`;
        (State.sections || []).forEach(sec => {
          tplXml += `  <void property="tabbedPaneName"><string>${escapeXml(sec.name)}</string></void>\n`;
        });
        tplXml += `</object>\n</java>`;
        zip.file("TabbedPanes.tpl", tplXml);

        // 3. DamagePanels.xml
        let dmgXml = `<?xml version="1.0" encoding="UTF-8"?>\n<java version="1.8.0_131" class="java.beans.XMLDecoder">\n`;
        (State.sections || []).forEach(sec => {
          (sec.items || []).forEach(it => {
            const fullName = `${sec.name}${it.name}`;
            dmgXml += `  <object class="homeinspectorpro.DamagePanelInfo">\n`;
            dmgXml += `    <void property="name"><string>${escapeXml(fullName)}</string></void>\n`;
            if (it.status === 'Safety Hazard' || it.status === 'Defective') {
              dmgXml += `    <void property="damageStatusRedVector"><void method="add"><string>${escapeXml(it.comments || it.status)}</string></void></void>\n`;
            } else if (it.status === 'Marginal') {
              dmgXml += `    <void property="damageStatusBlackVector"><void method="add"><string>${escapeXml(it.comments || it.status)}</string></void></void>\n`;
            } else if (it.comments) {
              dmgXml += `    <void property="damageStatusVector"><void method="add"><string>${escapeXml(it.comments)}</string></void></void>\n`;
            }
            dmgXml += `  </object>\n`;
          });
        });
        dmgXml += `</java>`;
        zip.file("DamagePanels.xml", dmgXml);

        // 4. PhotoInfo.xml & Photos
        let photoXml = `<?xml version="1.0" encoding="UTF-8"?>\n<java version="1.8.0_131" class="java.beans.XMLDecoder">\n`;
        const writtenPhotos = new Set();

        for (const sec of (State.sections || [])) {
          for (const it of (sec.items || [])) {
            for (const p of (it.photos || [])) {
              const rawName = p.filename || `photo_${writtenPhotos.size + 1}.jpg`;
              const cleanFname = rawName.split('/').pop().split('\\').pop();
              photoXml += `  <object class="homeinspectorpro.PhotoInfo">\n`;
              photoXml += `    <void property="fileName"><string>${escapeXml(cleanFname)}</string></void>\n`;
              photoXml += `    <void property="areaName"><string>${escapeXml(sec.name)}</string></void>\n`;
              photoXml += `    <void property="itemName"><string>${escapeXml(it.name)}</string></void>\n`;
              photoXml += `    <void property="caption"><string>${escapeXml(p.caption || '')}</string></void>\n`;
              photoXml += `  </object>\n`;

              if (p.dataUrl && !writtenPhotos.has(cleanFname)) {
                writtenPhotos.add(cleanFname);
                try {
                  if (p.dataUrl.includes(',')) {
                    const base64Data = p.dataUrl.split(',')[1];
                    zip.file(cleanFname, base64Data, { base64: true });
                  } else if (p.dataUrl.startsWith('blob:') || p.dataUrl.startsWith('http')) {
                    const imgResp = await fetch(p.dataUrl);
                    const imgBlob = await imgResp.blob();
                    zip.file(cleanFname, imgBlob);
                  } else {
                    zip.file(cleanFname, p.dataUrl, { base64: true });
                  }
                } catch (photoErr) {
                  console.warn(`Failed to package photo ${cleanFname}:`, photoErr);
                }
              }
            }
          }
        }
        photoXml += `</java>`;
        zip.file("PhotoInfo.xml", photoXml);

        // 5. Standard InspectionData.xml for 100% lossless cross-compatibility
        let inspXml = `<InspectionReport created="${new Date().toISOString()}" version="2.0">`;
        inspXml += `<ClientInfo>`;
        for (const [k, v] of Object.entries(State.clientInfo || {})) {
          if (v) inspXml += `<${k}>${escapeXml(String(v))}</${k}>`;
        }
        inspXml += `</ClientInfo>`;
        inspXml += `<Sections>`;
        (State.sections || []).forEach(s => {
          inspXml += `<Section id="${escapeXml(s.id)}" name="${escapeXml(s.name)}"><Summary>${escapeXml(s.desc||s.summary||'')}</Summary><Items>`;
          (s.items || []).forEach(it => {
            inspXml += `<Item id="${escapeXml(it.id)}" name="${escapeXml(it.name)}"><Status>${escapeXml(it.status || 'Satisfactory')}</Status><Comments>${escapeXml(it.comments||'')}</Comments><Photos>`;
            (it.photos || []).forEach(p => {
              const cleanFname = (p.filename || '').split('/').pop().split('\\').pop();
              inspXml += `<Photo filename="${escapeXml(cleanFname)}" caption="${escapeXml(p.caption||'')}"/>`;
            });
            inspXml += `</Photos></Item>`;
          });
          inspXml += `</Items></Section>`;
        });
        inspXml += `</Sections></InspectionReport>`;
        zip.file("InspectionData.xml", inspXml);

        // 6. manifest.xml
        let manifestXml = `<?xml version="1.0" encoding="UTF-8"?>\n<HZFManifest>\n  <Software>Home Inspector Pro Compatible Studio</Software>\n  <Version>2.0</Version>\n  <ExportDate>${new Date().toISOString()}</ExportDate>\n</HZFManifest>`;
        zip.file("manifest.xml", manifestXml);

        showToast(`Compiling .${format} archive (${writtenPhotos.size} photos)...`);

        // FAST GENERATE using STORE (instant packaging without heavy re-compression of JPEGs)
        const blob = await zip.generateAsync({
          type: "blob",
          compression: "STORE",
          streamFiles: true
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          } catch (_) {}
        }, 60000);
        showToast(`Downloaded ${downloadName}!`);
        return;
      } catch (err) {
        console.warn("Client export warning:", err);
      }
    }

    // Backend export fallback if JSZip not available or failed
    try {
      showToast(`Generating .${format} via server...`);
      const endpoint = (format === 'bin') ? '/api/export-bin' : '/api/export-hzf';
      const resp = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: downloadName,
          clientInfo: State.clientInfo,
          sections: State.sections
        })
      });
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.detail || `Server returned HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, 60000);
      showToast(`Downloaded ${downloadName}!`);
    } catch (e) {
      showToast("Download failed: " + e.message);
    }
  }

  // DOM Event Listeners
  document.addEventListener('DOMContentLoaded', async () => {

    // Immediate auth check on DOM load to prevent flash of studio in background
    if (!localStorage.getItem("hzf_auth_token")) {
      document.body.classList.add("auth-mode-active");
      const authOverlay = document.getElementById("authScreen");
      if (authOverlay) authOverlay.style.display = "flex";
    }

    // ------------------------------------------------------------------------
    // AUTHENTICATION & ADMIN CONTROLS WIRING
    // ------------------------------------------------------------------------
    document.getElementById('tabAuthLogin')?.addEventListener('click', () => setAuthTab('login'));
    document.getElementById('tabAuthRegister')?.addEventListener('click', () => setAuthTab('register'));
    document.getElementById('linkSwitchToRegister')?.addEventListener('click', (e) => { e.preventDefault(); setAuthTab('register'); });
    document.getElementById('linkSwitchToLogin')?.addEventListener('click', (e) => { e.preventDefault(); setAuthTab('login'); });
    document.getElementById('btnBackToAuth')?.addEventListener('click', (e) => { e.preventDefault(); setAuthTab('login'); });
    document.getElementById('linkForgotPassword')?.addEventListener('click', (e) => {
      e.preventDefault();
      const currentEmail = document.getElementById('loginEmail')?.value.trim();
      if (currentEmail) pendingAuthEmail = currentEmail;
      setAuthTab('forgot');
    });
    document.getElementById('linkBackToLoginFromForgot')?.addEventListener('click', (e) => { e.preventDefault(); setAuthTab('login'); });
    document.getElementById('linkBackToLoginFromReset')?.addEventListener('click', (e) => { e.preventDefault(); setAuthTab('login'); });

    // Login Form Submit
    document.getElementById('formAuthLogin')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail')?.value.trim();
      const password = document.getElementById('loginPassword')?.value;
      const btn = document.getElementById('btnLoginSubmit');

      if (!email || !password) {
        showAuthAlert("Please provide both email and password.");
        return;
      }

      const oldBtnHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.innerHTML = `<span class="spinner" style="width:13px;height:13px;border-width:2px;display:inline-block;margin-right:6px;"></span> Signing In...`;
        btn.disabled = true;
      }
      showAuthAlert("");

      try {
        const resp = await _nativeFetch(apiUrl('/api/auth/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const res = await resp.json();

        if (resp.ok && res.success) {
          if (res.requires_verification) {
            pendingAuthEmail = email;
            setAuthTab('otp');
            showAuthAlert("A verification code was sent to your email. Please enter it below to activate your account.", "info");
            return;
          }
          State.authToken = res.token;
          State.currentUser = res.user;
          localStorage.setItem('hzf_auth_token', res.token);
          localStorage.setItem('hzf_user_info', JSON.stringify(res.user));
          updateUserToolbar(res.user);
          hideAuthScreen();
          showToast(`Welcome back, ${res.user.name || res.user.email}!`);

          if (res.user.role === 'admin') {
            openAdminPanel();
          } else {
            refreshSavedReportsCount();
          }
        } else {
          showAuthAlert(res.detail || res.message || "Invalid email or password.");
        }
      } catch (err) {
        showAuthAlert("Connection error: " + err.message);
      } finally {
        if (btn) {
          btn.innerHTML = oldBtnHtml;
          btn.disabled = false;
        }
      }
    });

    // Sign Up Form Submit
    document.getElementById('formAuthRegister')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('regName')?.value.trim();
      const phone = document.getElementById('regPhone')?.value.trim();
      const org = document.getElementById('regOrg')?.value.trim();
      const email = document.getElementById('regEmail')?.value.trim();
      const password = document.getElementById('regPassword')?.value;
      const confirmPassword = document.getElementById('regConfirmPassword')?.value;
      const btn = document.getElementById('btnRegisterSubmit');

      if (!name || !phone || !email || !password) {
        showAuthAlert("Please fill in all required fields.");
        return;
      }
      if (password !== confirmPassword) {
        showAuthAlert("Passwords do not match. Please re-enter.");
        return;
      }
      if (password.length < 6) {
        showAuthAlert("Password must be at least 6 characters.");
        return;
      }

      const oldBtnHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.innerHTML = `<span class="spinner" style="width:13px;height:13px;border-width:2px;display:inline-block;margin-right:6px;"></span> Sending Verification Code...`;
        btn.disabled = true;
      }
      showAuthAlert("");

      try {
        const resp = await _nativeFetch(apiUrl('/api/auth/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, phone, organization: org, email, password })
        });
        const res = await resp.json();

        if (resp.ok && res.success) {
          pendingAuthEmail = email;
          setAuthTab('otp');
          if (res.dev_otp) {
            console.log("DEV OTP CODE:", res.dev_otp);
          }
          showAuthAlert(res.message || "Verification code dispatched! Please check your email inbox.", "success");
        } else {
          showAuthAlert(res.detail || res.message || "Registration failed.");
        }
      } catch (err) {
        showAuthAlert("Registration error: " + err.message);
      } finally {
        if (btn) {
          btn.innerHTML = oldBtnHtml;
          btn.disabled = false;
        }
      }
    });

    // OTP Verification Submit
    document.getElementById('formAuthOtp')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const otpCode = document.getElementById('otpCodeInput')?.value.trim();
      const btn = document.getElementById('btnVerifyOtpSubmit');

      if (!otpCode || otpCode.length !== 6) {
        showAuthAlert("Please enter the complete 6-digit verification code.");
        return;
      }

      const oldBtnHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.innerHTML = `<span class="spinner" style="width:13px;height:13px;border-width:2px;display:inline-block;margin-right:6px;"></span> Verifying Code...`;
        btn.disabled = true;
      }
      showAuthAlert("");

      try {
        const resp = await _nativeFetch(apiUrl('/api/auth/verify-otp'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingAuthEmail, otp: otpCode, otp_code: otpCode })
        });
        const res = await resp.json();

        if (resp.ok && res.success) {
          State.authToken = res.token;
          State.currentUser = res.user;
          localStorage.setItem('hzf_auth_token', res.token);
          localStorage.setItem('hzf_user_info', JSON.stringify(res.user));
          updateUserToolbar(res.user);
          hideAuthScreen();
          showToast(`Account verified! Welcome to HZF Inspector Studio.`);

          if (res.user.role === 'admin') {
            openAdminPanel();
          } else {
            refreshSavedReportsCount();
          }
        } else {
          showAuthAlert(res.detail || res.message || "Invalid verification code.");
        }
      } catch (err) {
        showAuthAlert("Verification error: " + err.message);
      } finally {
        if (btn) {
          btn.innerHTML = oldBtnHtml;
          btn.disabled = false;
        }
      }
    });

    // Resend OTP Code
    document.getElementById('btnResendOtp')?.addEventListener('click', async () => {
      if (!pendingAuthEmail) {
        showAuthAlert("Please enter your email to request a code.");
        return;
      }
      try {
        const resp = await _nativeFetch(apiUrl('/api/auth/resend-otp'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingAuthEmail })
        });
        const res = await resp.json();
        if (resp.ok && res.success) {
          if (res.dev_otp) console.log("DEV RESENT OTP:", res.dev_otp);
          showAuthAlert("A new verification code has been dispatched to your email.", "success");
        } else {
          showAuthAlert(res.detail || "Unable to resend code right now.");
        }
      } catch (err) {
        showAuthAlert("Error resending code: " + err.message);
      }
    });

    // Forgot Password Request Form Submit
    document.getElementById('formAuthForgotPassword')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgotEmail')?.value.trim();
      const btn = document.getElementById('btnForgotSubmit');

      if (!email) {
        showAuthAlert("Please enter your registered email address.");
        return;
      }

      const oldBtnHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.innerHTML = `<span class="spinner" style="width:13px;height:13px;border-width:2px;display:inline-block;margin-right:6px;"></span> Sending Reset Code...`;
        btn.disabled = true;
      }
      showAuthAlert("");

      try {
        const resp = await _nativeFetch(apiUrl('/api/auth/forgot-password/request'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const res = await resp.json();

        if (resp.ok && res.success) {
          pendingAuthEmail = email;
          setAuthTab('reset-password');
          showAuthAlert(res.message || "A 6-digit password reset code has been sent to your email.", "success");
        } else {
          showAuthAlert(res.detail || res.message || "Unable to send password reset code.");
        }
      } catch (err) {
        showAuthAlert("Network error: " + err.message);
      } finally {
        if (btn) {
          btn.innerHTML = oldBtnHtml;
          btn.disabled = false;
        }
      }
    });

    // Reset Password Form Submit
    document.getElementById('formAuthResetPassword')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const otpCode = document.getElementById('resetOtpCode')?.value.trim();
      const newPassword = document.getElementById('resetNewPassword')?.value;
      const confirmPassword = document.getElementById('resetConfirmPassword')?.value;
      const btn = document.getElementById('btnResetPasswordSubmit');

      if (!otpCode || otpCode.length !== 6) {
        showAuthAlert("Please enter the complete 6-digit reset code.");
        return;
      }

      if (!newPassword || newPassword.length < 6) {
        showAuthAlert("Password must be at least 6 characters long.");
        return;
      }

      if (newPassword !== confirmPassword) {
        showAuthAlert("Passwords do not match. Please verify and re-enter.");
        return;
      }

      const oldBtnHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.innerHTML = `<span class="spinner" style="width:13px;height:13px;border-width:2px;display:inline-block;margin-right:6px;"></span> Updating Password...`;
        btn.disabled = true;
      }
      showAuthAlert("");

      try {
        const resp = await _nativeFetch(apiUrl('/api/auth/forgot-password/reset'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: pendingAuthEmail,
            otp: otpCode,
            new_password: newPassword
          })
        });
        const res = await resp.json();

        if (resp.ok && res.success) {
          setAuthTab('login');
          const loginEmailInput = document.getElementById('loginEmail');
          if (loginEmailInput) loginEmailInput.value = pendingAuthEmail;
          const loginPasswordInput = document.getElementById('loginPassword');
          if (loginPasswordInput) {
            loginPasswordInput.value = "";
            setTimeout(() => loginPasswordInput.focus(), 80);
          }
          showAuthAlert(res.message || "Password updated successfully! Please log in with your new password.", "success");
        } else {
          showAuthAlert(res.detail || res.message || "Password update failed. Please check the code and try again.");
        }
      } catch (err) {
        showAuthAlert("Network error: " + err.message);
      } finally {
        if (btn) {
          btn.innerHTML = oldBtnHtml;
          btn.disabled = false;
        }
      }
    });

    // Resend Reset Code Button
    document.getElementById('btnResendResetOtp')?.addEventListener('click', async () => {
      if (!pendingAuthEmail) {
        showAuthAlert("Please provide your email address first.");
        return;
      }
      try {
        const resp = await _nativeFetch(apiUrl('/api/auth/forgot-password/request'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingAuthEmail })
        });
        const res = await resp.json();
        if (resp.ok && res.success) {
          showAuthAlert("A new reset code has been sent to your email inbox.", "success");
        } else {
          showAuthAlert(res.detail || "Unable to resend code right now.");
        }
      } catch (err) {
        showAuthAlert("Error resending reset code: " + err.message);
      }
    });

    // Toolbar Logout Button
    document.getElementById('btnNavLogout')?.addEventListener('click', () => {
      handleAuthLogout(true);
    });

    // Toolbar Admin Panel Button
    document.getElementById('btnNavAdmin')?.addEventListener('click', () => {
      openAdminPanel();
    });

    // Admin Back To Dashboard from Workspace
    document.getElementById('btnAdminBackToDash')?.addEventListener('click', () => {
      openAdminPanel();
    });

    // Admin Panel Actions
    document.getElementById('btnAdminBackToStudio')?.addEventListener('click', () => {
      closeAdminPanel();
    });

    document.getElementById('btnAdminRefresh')?.addEventListener('click', () => {
      loadAdminDashboard();
      showToast("Administrator dashboard data refreshed.");
    });

    // Admin Search Filter
    document.getElementById('adminUserSearchInput')?.addEventListener('input', (e) => {
      const q = (e.target.value || '').toLowerCase().trim();
      if (!adminUsersCache || adminUsersCache.length === 0) return;
      if (!q) {
        renderAdminUsersTable(adminUsersCache);
      } else {
        const filtered = adminUsersCache.filter(u => {
          return (u.name && u.name.toLowerCase().includes(q)) ||
                 (u.email && u.email.toLowerCase().includes(q)) ||
                 (u.organization && u.organization.toLowerCase().includes(q)) ||
                 (u.phone && u.phone.includes(q)) ||
                 (u.role && u.role.toLowerCase().includes(q));
        });
        renderAdminUsersTable(filtered);
      }
    });

    // Admin User Reports Modal Close & Outside Click
    document.getElementById('btnCloseAdminUserModal')?.addEventListener('click', () => {
      const m = document.getElementById('adminUserModal');
      if (m) m.style.display = 'none';
    });
    document.getElementById('btnCloseAdminUserModalBtn')?.addEventListener('click', () => {
      const m = document.getElementById('adminUserModal');
      if (m) m.style.display = 'none';
    });
    document.getElementById('adminUserModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'adminUserModal') {
        const m = document.getElementById('adminUserModal');
        if (m) m.style.display = 'none';
      }
    });

    // Admin Delete Inspector Confirmation Pop Card Listeners
    document.getElementById('btnCloseDeleteUserModal')?.addEventListener('click', hideDeleteConfirmModal);
    document.getElementById('btnCancelDeleteUser')?.addEventListener('click', hideDeleteConfirmModal);
    document.getElementById('adminDeleteUserModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'adminDeleteUserModal') hideDeleteConfirmModal();
    });

    document.getElementById('btnConfirmDeleteUser')?.addEventListener('click', async () => {
      if (!pendingDeleteUser) return;
      const btn = document.getElementById('btnConfirmDeleteUser');
      const oldHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;margin-right:6px;"></span> Deleting...`;
        btn.disabled = true;
      }
      try {
        const token = State.authToken || localStorage.getItem("hzf_auth_token");
        const resp = await fetch(apiUrl(`/api/admin/users/${pendingDeleteUser.id}`), {
          method: "DELETE",
          headers: token ? { "Authorization": `Bearer ${token}` } : {}
        });
        const res = await resp.json();
        if (resp.ok && res.success) {
          hideDeleteConfirmModal();
          // Also hide adminUserModal if it was currently showing this user
          const userModal = document.getElementById('adminUserModal');
          if (userModal) userModal.style.display = 'none';
          showToast("Inspector account deleted successfully.");
          loadAdminDashboard();
        } else {
          alert(res.detail || "Failed to delete user.");
          if (btn) {
            btn.innerHTML = oldHtml;
            btn.disabled = false;
          }
        }
      } catch (e) {
        alert("Error: " + e.message);
        if (btn) {
          btn.innerHTML = oldHtml;
          btn.disabled = false;
        }
      }
    });

    // Admin Deactivate/Activate Inspector Modal Listeners
    document.getElementById('btnCloseToggleStatusModal')?.addEventListener('click', hideToggleStatusModal);
    document.getElementById('btnCancelToggleStatus')?.addEventListener('click', hideToggleStatusModal);
    document.getElementById('adminToggleStatusModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'adminToggleStatusModal') hideToggleStatusModal();
    });

    document.getElementById('btnConfirmToggleStatus')?.addEventListener('click', async () => {
      if (!pendingToggleUser) return;
      const targetUser = pendingToggleUser;
      const targetId = targetUser.id;
      const btn = document.getElementById('btnConfirmToggleStatus');
      const oldHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;margin-right:6px;"></span> Updating...`;
        btn.disabled = true;
      }
      try {
        const token = State.authToken || localStorage.getItem("hzf_auth_token");
        const resp = await fetch(apiUrl(`/api/admin/users/${targetId}/toggle-status`), {
          method: "POST",
          headers: token ? { "Authorization": `Bearer ${token}` } : {}
        });
        const res = await resp.json();
        if (resp.ok && res.success) {
          const newActive = !!res.isActive;

          // Update local cache
          const cached = adminUsersCache.find(u => String(u.id) === String(targetId));
          if (cached) {
            cached.isActive = newActive;
            cached.is_active = newActive;
          }

          const reopenUserModal = wasAdminUserModalOpenForToggle;
          hideToggleStatusModal();
          showToast(res.message || "Inspector status updated.");

          if (reopenUserModal) {
            openAdminUserModal(targetId);
          }

          loadAdminDashboard();
        } else {
          showToast(res.detail || "Failed to update inspector status.", "error");
          if (btn) {
            btn.innerHTML = oldHtml;
            btn.disabled = false;
          }
        }
      } catch (e) {
        showToast("Error: " + e.message, "error");
        if (btn) {
          btn.innerHTML = oldHtml;
          btn.disabled = false;
        }
      }
    });

    // Check Authentication Session on Startup
    await checkAuthSession();

    // Wire up Confirmation Leave Modal
    const confirmModal = document.getElementById('confirmLeaveModal');
    document.getElementById('btnCloseConfirmLeave')?.addEventListener('click', hideConfirmLeaveModal);
    document.getElementById('btnStayInWorkspace')?.addEventListener('click', hideConfirmLeaveModal);
    confirmModal?.addEventListener('click', (e) => {
      if (e.target.id === 'confirmLeaveModal') hideConfirmLeaveModal();
    });

    document.getElementById('btnSaveAndLeave')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnSaveAndLeave');
      const oldHtml = btn.innerHTML;
      btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span> Saving to library...`;
      btn.disabled = true;
      try {
        await saveActiveReport();
        await clearActiveSession();
        hideConfirmLeaveModal();
        setWorkspaceActive(false, true);
        showToast("Inspection saved to library. Returned to dashboard.");
      } finally {
        btn.innerHTML = oldHtml;
        btn.disabled = false;
      }
    });

    document.getElementById('btnDiscardAndLeave')?.addEventListener('click', async () => {
      await clearActiveSession();
      hideConfirmLeaveModal();
      setWorkspaceActive(false, true);
      showToast("Returned to dashboard.");
    });

    // Listen to browser Back / Forward history navigation
    window.addEventListener('popstate', (e) => {
      const isWorkspaceHash = (window.location.hash === '#workspace');
      if (isWorkspaceHash) {
        if (!State.isInspectionActive) {
          setWorkspaceActive(true, false);
        }
      } else {
        if (State.isInspectionActive && State.sections && State.sections.length > 0) {
          try {
            history.pushState({ view: 'workspace' }, '', '#workspace');
          } catch (err) {}
          showConfirmLeaveModal();
        } else {
          setWorkspaceActive(false, false);
        }
      }
    });

    // Dedicated Back Buttons
    const navBackBtn = document.getElementById('btnNavBack');
    if (navBackBtn) navBackBtn.addEventListener('click', goBackHome);

    const heroBackBtn = document.getElementById('btnHeroBack');
    if (heroBackBtn) heroBackBtn.addEventListener('click', goBackHome);

    // Brand Home Button
    const brandBtn = document.getElementById('brandHomeBtn');
    if (brandBtn) {
      brandBtn.addEventListener('click', () => {
        if (State.currentUser && State.currentUser.role === 'admin') {
          openAdminPanel();
          return;
        }
        if (State.isInspectionActive) {
          goBackHome();
        }
      });
    }

    // Top toolbar Save button
    document.getElementById('btnSaveInspection')?.addEventListener('click', saveActiveReport);

    // Auto-save property form changes
    document.getElementById('tabProperty')?.addEventListener('input', () => {
      syncFormToState();
    });

    // Before unload listener to save sync
    window.addEventListener('beforeunload', () => {
      if (State.isInspectionActive) {
        syncFormToState();
        saveActiveSession();
      }
    });

    // Restore active inspection session on page refresh (F5) or clean start
    // Step 1: Instant synchronous restore from sessionStorage
    let sessionRestored = false;
    try {
      const rawSession = sessionStorage.getItem('hzf_active_session_v4');
      if (rawSession) {
        const syncSession = JSON.parse(rawSession);
        if (syncSession && syncSession.isInspectionActive && syncSession.sections && syncSession.sections.length > 0) {
          State.fileName = syncSession.fileName || 'Untitled_Inspection.hzf';
          State.activeReportId = syncSession.activeReportId || null;
          State.clientInfo = syncSession.clientInfo || {};
          State.sections = syncSession.sections || [];
          State.activeSectionId = syncSession.activeSectionId || (State.sections[0] ? State.sections[0].id : null);
          State.isDirty = !!syncSession.isDirty;
          State.isInspectionActive = true;
          State.activeTab = syncSession.activeTab || 'checklist';

          // Set workspace active immediately
          setWorkspaceActive(true, false);
          if (window.location.hash !== '#workspace') {
            history.replaceState({ view: 'workspace' }, '', '#workspace');
          }

          // Restore tab
          const savedTab = syncSession.activeTab || 'checklist';
          const tabBtn = document.querySelector(`.nav-tab[data-tab="${savedTab}"]`);
          if (tabBtn) tabBtn.click();

          sessionRestored = true;
          showToast(`Workspace restored: ${State.fileName}`);
        }
      }
    } catch (e) {
      console.warn("Sync session restore error:", e);
    }

    // Step 2: Hydrate full photos and data from IndexedDB
    try {
      const fullSession = await getActiveSession();
      if (fullSession && fullSession.isInspectionActive && fullSession.sections && fullSession.sections.length > 0) {
        State.fileName = fullSession.fileName || State.fileName;
        State.activeReportId = fullSession.activeReportId || State.activeReportId;
        State.clientInfo = fullSession.clientInfo || State.clientInfo;
        State.sections = fullSession.sections || State.sections;
        State.activeSectionId = fullSession.activeSectionId || State.activeSectionId;
        State.isDirty = !!fullSession.isDirty;
        State.isInspectionActive = true;
        State.activeTab = fullSession.activeTab || State.activeTab || 'checklist';

        if (!sessionRestored) {
          setWorkspaceActive(true, false);
          if (window.location.hash !== '#workspace') {
            history.replaceState({ view: 'workspace' }, '', '#workspace');
          }
          const savedTab = fullSession.activeTab || 'checklist';
          const tabBtn = document.querySelector(`.nav-tab[data-tab="${savedTab}"]`);
          if (tabBtn) tabBtn.click();
          sessionRestored = true;
          showToast(`Workspace restored: ${State.fileName}`);
        } else {
          renderAll();
        }
      }
    } catch (e) {
      console.warn("Async session restore error:", e);
    }

    if (!sessionRestored) {
      // Clean start on Welcome Screen (for inspectors) or Admin Panel (for admin)
      if (window.location.hash === '#workspace') {
        history.replaceState({ view: 'home' }, '', window.location.pathname + window.location.search);
      }
      if (State.currentUser && State.currentUser.role === 'admin') {
        openAdminPanel();
      } else {
        setWorkspaceActive(false, false);
      }
    }

    // Build New Inspection / Start Blank Inspection triggers
    const blankBtn = document.getElementById('btnCreateBlank');
    if (blankBtn) blankBtn.addEventListener('click', startBlankInspection);

    const newInspBtn = document.getElementById('btnStartNewInspection');
    if (newInspBtn) newInspBtn.addEventListener('click', startBlankInspection);

    const newCard = document.getElementById('newInspectionCard');
    if (newCard) {
      newCard.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') startBlankInspection();
      });
    }

    // Open Existing File Triggers
    const fileInput = document.getElementById('fileUploadInput');
    document.getElementById('btnBrowseFile')?.addEventListener('click', () => fileInput?.click());
    document.getElementById('btnOpenExisting')?.addEventListener('click', () => fileInput?.click());
    document.getElementById('dropZoneCard')?.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') fileInput?.click();
    });

    fileInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        loadUserFile(e.target.files[0]);
      }
    });

    // Drag and Drop on Welcome Screen
    const dropCard = document.getElementById('dropZoneCard');
    if (dropCard) {
      ['dragenter', 'dragover'].forEach(evt => {
        dropCard.addEventListener(evt, (e) => {
          e.preventDefault();
          dropCard.style.borderColor = 'var(--accent)';
        });
      });

      ['dragleave', 'drop'].forEach(evt => {
        dropCard.addEventListener(evt, (e) => {
          e.preventDefault();
          dropCard.style.borderColor = '';
        });
      });

      dropCard.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          loadUserFile(e.dataTransfer.files[0]);
        }
      });
    }

    // Saved Reports Modal
    const savedModal = document.getElementById('savedReportsModal');
    function openSavedReportsModal() {
      loadSavedReportsModal();
      if (savedModal) savedModal.style.display = 'flex';
    }

    document.getElementById('btnOpenSavedReports')?.addEventListener('click', openSavedReportsModal);
    document.getElementById('btnWelcomeOpenSaved')?.addEventListener('click', openSavedReportsModal);
    document.getElementById('welcomeSavedReportsCard')?.addEventListener('click', openSavedReportsModal);
    document.getElementById('btnCloseSavedReportsModal')?.addEventListener('click', () => { if (savedModal) savedModal.style.display = 'none'; });
    document.getElementById('btnDismissSavedReports')?.addEventListener('click', () => { if (savedModal) savedModal.style.display = 'none'; });
    savedModal?.addEventListener('click', (e) => {
      if (e.target === savedModal) savedModal.style.display = 'none';
    });

    // Save and Export Triggers
    document.getElementById('btnSaveToLibrary')?.addEventListener('click', saveActiveReport);
    document.getElementById('btnSavePdf')?.addEventListener('click', () => downloadPdfReport());
    document.getElementById('btnSaveHzf')?.addEventListener('click', () => exportFile('hzf'));
    document.getElementById('btnSaveBin')?.addEventListener('click', () => exportFile('bin'));

    // In Report Tab: Direct PDF download and Live Preview Controls
    document.getElementById('btnDownloadPdfTab')?.addEventListener('click', () => downloadPdfReport());
    document.getElementById('btnRefreshPdfPreview')?.addEventListener('click', () => loadPdfPreview(true));
    document.getElementById('btnOpenPdfNewTab')?.addEventListener('click', () => openPdfInNewTab());
    document.getElementById('btnPrintPdfTab')?.addEventListener('click', () => printFullPdfReport());
    document.getElementById('btnPdfPrevPage')?.addEventListener('click', () => {
      if (State.pdfDoc && State.pdfCurrentPage > 1) {
        renderPdfPage(State.pdfCurrentPage - 1);
      }
    });
    document.getElementById('btnPdfNextPage')?.addEventListener('click', () => {
      if (State.pdfDoc && State.pdfCurrentPage < State.pdfTotalPages) {
        renderPdfPage(State.pdfCurrentPage + 1);
      }
    });
    document.getElementById('pdfPageIndicator')?.addEventListener('click', () => {
      if (!State.pdfTotalPages || State.pdfTotalPages <= 1) return;
      const target = prompt(`Go to page (1 - ${State.pdfTotalPages}):`, State.pdfCurrentPage || 1);
      if (target) {
        const pNum = parseInt(target, 10);
        if (!isNaN(pNum) && pNum >= 1 && pNum <= State.pdfTotalPages) {
          renderPdfPage(pNum);
        }
      }
    });

    document.getElementById('btnPdfFitPage')?.addEventListener('click', () => {
      State.pdfFitMode = 'page';
      State.pdfCurrentScale = null;
      renderPdfPage(State.pdfCurrentPage || 1, true);
    });

    document.getElementById('btnPdfFitWidth')?.addEventListener('click', () => {
      State.pdfFitMode = 'width';
      State.pdfCurrentScale = null;
      renderPdfPage(State.pdfCurrentPage || 1, true);
    });

    document.getElementById('btnPdfZoomOut')?.addEventListener('click', () => {
      const cur = State.pdfCurrentScale || 1.0;
      State.pdfFitMode = 'custom';
      State.pdfCurrentScale = Math.max(0.25, cur * 0.85);
      renderPdfPage(State.pdfCurrentPage || 1, false);
    });

    document.getElementById('btnPdfZoomIn')?.addEventListener('click', () => {
      const cur = State.pdfCurrentScale || 1.0;
      State.pdfFitMode = 'custom';
      State.pdfCurrentScale = Math.min(4.0, cur * 1.15);
      renderPdfPage(State.pdfCurrentPage || 1, false);
    });

    window.addEventListener('keydown', (e) => {
      const tabReport = document.getElementById('tabReport');
      if (!tabReport || tabReport.style.display === 'none') return;
      if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (State.pdfDoc && State.pdfCurrentPage > 1) {
          e.preventDefault();
          renderPdfPage(State.pdfCurrentPage - 1);
        }
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (State.pdfDoc && State.pdfCurrentPage < State.pdfTotalPages) {
          e.preventDefault();
          renderPdfPage(State.pdfCurrentPage + 1);
        }
      }
    });

    window.addEventListener('resize', () => {
      const tabReport = document.getElementById('tabReport');
      if (tabReport && tabReport.style.display !== 'none' && State.pdfDoc) {
        clearTimeout(window._pdfResizeTimer);
        window._pdfResizeTimer = setTimeout(() => {
          renderPdfPage(State.pdfCurrentPage || 1);
        }, 150);
      }
    });

    const printRepBtn = document.getElementById('btnPrintReport');
    if (printRepBtn) {
      printRepBtn.addEventListener('click', () => printFullPdfReport());
    }

    const printTabBtn = document.getElementById('btnPrintPdfTab');
    if (printTabBtn) {
      printTabBtn.addEventListener('click', () => printFullPdfReport());
    }

    const printPdfOld = document.getElementById('btnPrintPdf');
    if (printPdfOld) printPdfOld.addEventListener('click', () => downloadPdfReport());

    // Export Dropdown Menu Trigger
    const exportContainer = document.getElementById('exportMenuContainer');
    const exportTrigger = document.getElementById('btnExportTrigger');
    if (exportTrigger && exportContainer) {
      exportTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        exportContainer.classList.toggle('open');
      });
    }

    // Dismiss export dropdown when selecting an export action or clicking outside
    document.querySelectorAll('#exportDropdownMenu .dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        if (exportContainer) exportContainer.classList.remove('open');
      });
    });
    document.addEventListener('click', (e) => {
      if (exportContainer && !exportContainer.contains(e.target)) {
        exportContainer.classList.remove('open');
      }
    });

    // Mobile Navigation Drawer and Backdrop Handlers
    const mobileDrawer = document.getElementById('mobileNavDrawer');
    const mobileBackdrop = document.getElementById('mobileNavBackdrop');
    const btnNavMore = document.getElementById('btnNavMore');
    const btnCloseDrawer = document.getElementById('btnCloseNavDrawer');

    function toggleMobileDrawer(open) {
      if (!mobileDrawer) return;
      const isOpen = (typeof open === 'boolean') ? open : (mobileDrawer.style.display !== 'flex');
      mobileDrawer.style.display = isOpen ? 'flex' : 'none';
      if (mobileBackdrop) mobileBackdrop.style.display = isOpen ? 'block' : 'none';
      if (isOpen && window.lucide) lucide.createIcons();
    }

    if (btnNavMore) {
      btnNavMore.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMobileDrawer();
      });
    }

    if (btnCloseDrawer) {
      btnCloseDrawer.addEventListener('click', () => {
        toggleMobileDrawer(false);
      });
    }

    if (mobileBackdrop) {
      mobileBackdrop.addEventListener('click', () => {
        toggleMobileDrawer(false);
      });
    }

    // Dismiss dropdowns on clicks outside
    document.addEventListener('click', (e) => {
      if (exportContainer && !exportContainer.contains(e.target)) {
        exportContainer.classList.remove('open');
      }
      if (mobileDrawer && mobileDrawer.style.display === 'flex' && !mobileDrawer.contains(e.target) && (!btnNavMore || !btnNavMore.contains(e.target))) {
        toggleMobileDrawer(false);
      }
    });

    // Mobile Drawer Item Proxies to Core Actions
    document.getElementById('btnDrawerAi')?.addEventListener('click', () => {
      toggleMobileDrawer(false);
      document.getElementById('btnAiSettings')?.click();
    });

    document.getElementById('btnDrawerReports')?.addEventListener('click', () => {
      toggleMobileDrawer(false);
      document.getElementById('btnOpenSavedReports')?.click();
    });

    document.getElementById('btnDrawerOpen')?.addEventListener('click', () => {
      toggleMobileDrawer(false);
      document.getElementById('btnOpenExisting')?.click();
    });

    document.getElementById('btnDrawerNew')?.addEventListener('click', () => {
      toggleMobileDrawer(false);
      document.getElementById('btnStartNewInspection')?.click();
    });

    document.getElementById('btnDrawerTheme')?.addEventListener('click', () => {
      document.getElementById('btnThemeToggle')?.click();
    });

    // Tabs Navigation
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-tab');
        State.activeTab = target;
        saveActiveSession();
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll(`.nav-tab[data-tab="${target}"]`).forEach(t => t.classList.add('active'));

        const titleView = document.getElementById('titlebarCurrentView');
        if (titleView) {
          if (target === 'checklist') titleView.textContent = 'Checklist & Systems';
          else if (target === 'property') titleView.textContent = 'Client Information';
          else if (target === 'report') titleView.textContent = 'Report Preview';
        }

        const tabC = document.getElementById('tabChecklist');
        const tabP = document.getElementById('tabProperty');
        const tabR = document.getElementById('tabReport');
        if (tabC) {
          tabC.style.display = (target === 'checklist') ? 'flex' : 'none';
          tabC.classList.toggle('active-tab-panel', target === 'checklist');
          tabC.classList.toggle('hidden-tab-panel', target !== 'checklist');
        }
        if (tabP) {
          tabP.style.display = (target === 'property') ? 'block' : 'none';
          tabP.classList.toggle('active-tab-panel', target === 'property');
          tabP.classList.toggle('hidden-tab-panel', target !== 'property');
        }
        if (tabR) {
          tabR.style.display = (target === 'report') ? 'block' : 'none';
          tabR.classList.toggle('active-tab-panel', target === 'report');
          tabR.classList.toggle('hidden-tab-panel', target !== 'report');
        }

        if (target === 'report') {
          // Auto-generate preview if we have data but no cached PDF yet
          if (State.sections && State.sections.length > 0) {
            loadPdfPreview(!State.cachedPdfBlobUrl || State.pdfDirty);
          }
        }
      });
    });

    // Theme Toggle
    const themeBtn = document.getElementById('btnThemeToggle');
    themeBtn?.addEventListener('click', () => {
      document.body.classList.toggle('theme-dark');
      const isDark = document.body.classList.contains('theme-dark');
      const icon = document.getElementById('themeIcon');
      if (icon) icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');

      const drawerIcon = document.getElementById('drawerThemeIcon');
      const drawerText = document.getElementById('drawerThemeText');
      if (drawerIcon) drawerIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
      if (drawerText) drawerText.textContent = isDark ? 'Light Mode' : 'Dark Mode';

      if (window.lucide) lucide.createIcons();
    });

    // Save Property Form
    document.getElementById('btnSavePropertyForm')?.addEventListener('click', () => {
      syncFormToState();
      renderPropertyForm();
      renderReport();
      saveActiveReport();
    });

    // Add Item Modal
    const addItemModal = document.getElementById('addItemModal');
    document.getElementById('btnOpenAddItemModal')?.addEventListener('click', () => {
      const n = document.getElementById('modalNewItemName');
      const c = document.getElementById('modalNewItemComments');
      if (n) n.value = '';
      if (c) c.value = '';
      if (addItemModal) addItemModal.style.display = 'flex';
    });
    document.getElementById('btnCloseAddItemModal')?.addEventListener('click', () => { if (addItemModal) addItemModal.style.display = 'none'; });
    document.getElementById('btnCancelAddItemModal')?.addEventListener('click', () => { if (addItemModal) addItemModal.style.display = 'none'; });

    document.getElementById('btnConfirmAddItem')?.addEventListener('click', () => {
      const name = document.getElementById('modalNewItemName')?.value.trim();
      const comments = document.getElementById('modalNewItemComments')?.value.trim();
      const status = document.querySelector('input[name="modalItemStatus"]:checked')?.value || 'Satisfactory';

      if (!name) {
        showToast("Please enter an item name");
        return;
      }

      const sec = State.sections.find(s => s.id === State.activeSectionId);
      if (sec) {
        if (!sec.items) sec.items = [];
        sec.items.push({
          id: `it_${Date.now()}`,
          name: name,
          status: status,
          comments: comments,
          photos: []
        });
        State.isDirty = true;
        addItemModal.style.display = 'none';
        renderItems();
        updateMetrics();
        renderSidebar();
        renderReport();
        saveActiveSession();
        showToast(`Added ${name}`);
      }
    });

    // Add Section Modal
    const addSectionModal = document.getElementById('addSectionModal');
    document.getElementById('btnAddSectionSidebar').addEventListener('click', () => {
      document.getElementById('modalNewSectionName').value = '';
      document.getElementById('modalNewSectionDesc').value = '';
      addSectionModal.style.display = 'flex';
    });
    document.getElementById('btnCloseAddSectionModal').addEventListener('click', () => addSectionModal.style.display = 'none');
    document.getElementById('btnCancelAddSectionModal').addEventListener('click', () => addSectionModal.style.display = 'none');

    document.getElementById('btnConfirmAddSection').addEventListener('click', () => {
      const name = document.getElementById('modalNewSectionName').value.trim();
      const desc = document.getElementById('modalNewSectionDesc').value.trim();

      if (!name) {
        showToast("Please enter a section name");
        return;
      }

      const newSec = {
        id: `sec_${Date.now()}`,
        name: name,
        desc: desc,
        items: []
      };

      State.sections.push(newSec);
      State.activeSectionId = newSec.id;
      State.isDirty = true;
      addSectionModal.style.display = 'none';
      renderSidebar();
      renderItems();
      renderReport();
      saveActiveSession();
      showToast(`Created section "${name}"`);
    });

    // Photo Modal Controls
    const photoModal = document.getElementById('photoModal');
    document.getElementById('btnClosePhotoModal')?.addEventListener('click', () => { if (photoModal) photoModal.style.display = 'none'; });
    document.getElementById('btnCancelPhotoModal')?.addEventListener('click', () => { if (photoModal) photoModal.style.display = 'none'; });

    document.getElementById('btnSavePhotoCaption')?.addEventListener('click', () => {
      if (!State.activePhotoTarget) return;
      const { secId, itemId } = State.activePhotoTarget;
      const pIdx = State.activePhotoTarget.pIdx !== undefined ? State.activePhotoTarget.pIdx : State.activePhotoTarget.photoIdx;
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it && it.photos && it.photos[pIdx]) {
        it.photos[pIdx].caption = document.getElementById('photoModalCaption')?.value.trim() || '';
        State.isDirty = true;
        renderItems();
        renderReport();
        saveActiveSession();
        showToast("Caption updated");
      }
      if (photoModal) photoModal.style.display = 'none';
    });

    document.getElementById('btnDeletePhoto')?.addEventListener('click', () => {
      if (!State.activePhotoTarget) return;
      const { secId, itemId } = State.activePhotoTarget;
      const pIdx = State.activePhotoTarget.pIdx !== undefined ? State.activePhotoTarget.pIdx : State.activePhotoTarget.photoIdx;
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it && it.photos && it.photos[pIdx]) {
        it.photos.splice(pIdx, 1);
        State.isDirty = true;
        renderItems();
        renderReport();
        saveActiveSession();
        showToast("Photo deleted");
      }
      if (photoModal) photoModal.style.display = 'none';
    });

    document.getElementById('btnCropExistingPhoto')?.addEventListener('click', () => {
      if (!State.activePhotoTarget) return;
      const { secId, itemId } = State.activePhotoTarget;
      const pIdx = State.activePhotoTarget.pIdx !== undefined ? State.activePhotoTarget.pIdx : State.activePhotoTarget.photoIdx;
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      const photo = it?.photos?.[pIdx];
      if (!photo) return;
      if (photoModal) photoModal.style.display = 'none';
      openLiveCameraModal(secId, itemId, pIdx, photo.dataUrl, photo.caption);
    });

    // Live Camera & Photo Crop Modal Event Listeners
    document.getElementById('btnCloseLiveCameraModal')?.addEventListener('click', closeLiveCameraModal);
    document.getElementById('btnCancelLiveCamera')?.addEventListener('click', closeLiveCameraModal);
    document.getElementById('liveCameraModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'liveCameraModal') closeLiveCameraModal();
    });

    // Shutter button (snap live frame)
    document.getElementById('btnShutterCapture')?.addEventListener('click', () => {
      const video = document.getElementById('liveCameraVideo');
      if (!video || !video.videoWidth) {
        document.getElementById('liveCameraNativeAppInput')?.click();
        return;
      }
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.95);
      showCameraCropView(dataUrl);
    });

    // Flip Camera button
    document.getElementById('btnFlipCamera')?.addEventListener('click', async () => {
      currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
      await startCameraStream();
    });

    // Fallback file pickers
    document.getElementById('btnCameraUploadFallback')?.addEventListener('click', () => {
      document.getElementById('liveCameraFileInput')?.click();
    });
    document.getElementById('btnCameraNativeApp')?.addEventListener('click', () => {
      document.getElementById('liveCameraNativeAppInput')?.click();
    });

    document.getElementById('liveCameraFileInput')?.addEventListener('change', function () {
      const file = this.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => showCameraCropView(e.target.result);
      reader.readAsDataURL(file);
      this.value = '';
    });

    document.getElementById('liveCameraNativeAppInput')?.addEventListener('change', function () {
      const file = this.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => showCameraCropView(e.target.result);
      reader.readAsDataURL(file);
      this.value = '';
    });

    // Crop actions
    document.getElementById('btnRetakeFromCrop')?.addEventListener('click', async () => {
      showCameraViewfinder();
      await startCameraStream();
    });

    document.getElementById('btnRotateCropCw')?.addEventListener('click', () => {
      cropRotation = (cropRotation + 90) % 360;
      cropState.rect = null;
      setupAndDrawCropCanvas();
    });

    document.getElementById('btnRotateCropCcw')?.addEventListener('click', () => {
      cropRotation = (cropRotation + 270) % 360;
      cropState.rect = null;
      setupAndDrawCropCanvas();
    });

    document.getElementById('btnResetCrop')?.addEventListener('click', () => {
      cropState.rect = null;
      setupAndDrawCropCanvas();
    });

    // Aspect ratio selector buttons
    document.querySelectorAll('.btn-crop-ratio').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-crop-ratio').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const ratio = btn.getAttribute('data-ratio');
        if (ratio === '4/3') cropAspect = 4 / 3;
        else if (ratio === '16/9') cropAspect = 16 / 9;
        else if (ratio === '1/1') cropAspect = 1;
        else cropAspect = 'free';
        cropState.rect = null;
        setupAndDrawCropCanvas();
      });
    });

    // Confirm & Add Photo
    document.getElementById('btnConfirmPhotoCrop')?.addEventListener('click', saveCroppedPhotoToItem);

    // Canvas Pointer & Touch dragging
    const cropCanvas = document.getElementById('cropCanvas');
    if (cropCanvas) {
      cropCanvas.addEventListener('mousedown', (e) => {
        const pos = getCanvasTouchPos(cropCanvas, e);
        handleCropPointerDown(pos);
      });
      window.addEventListener('mousemove', (e) => {
        if (!cropState.isDragging && e.target !== cropCanvas) return;
        const pos = getCanvasTouchPos(cropCanvas, e);
        handleCropPointerMove(pos, cropCanvas);
      });
      window.addEventListener('mouseup', handleCropPointerUp);

      // Touch support for mobile devices
      cropCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const pos = getCanvasTouchPos(cropCanvas, e);
        handleCropPointerDown(pos);
      }, { passive: false });
      cropCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const pos = getCanvasTouchPos(cropCanvas, e);
        handleCropPointerMove(pos, cropCanvas);
      }, { passive: false });
      cropCanvas.addEventListener('touchend', handleCropPointerUp);
      cropCanvas.addEventListener('touchcancel', handleCropPointerUp);
    }

    // Automation & AI Modal Event Listeners
    checkAiConnection();

    // AI Settings Modal
    const aiModal = document.getElementById('aiSettingsModal');
    const btnAiSettings = document.getElementById('btnAiSettings');
    if (btnAiSettings && aiModal) {
      btnAiSettings.addEventListener('click', () => {
        checkAiConnection();
        aiModal.style.display = 'flex';
      });
    }
    document.getElementById('btnCloseAiSettingsModal')?.addEventListener('click', () => aiModal.style.display = 'none');
    document.getElementById('btnCancelAiSettings')?.addEventListener('click', () => aiModal.style.display = 'none');

    document.getElementById('btnSaveAiKey')?.addEventListener('click', async () => {
      const key = document.getElementById('aiApiKeyInput')?.value.trim();
      const model = document.getElementById('aiModelSelect')?.value || 'gemini-1.5-flash';
      if (!key) {
        showToast("Please enter an API key.");
        return;
      }
      showToast("Testing Gemini API connection...");
      try {
        const resp = await fetch(apiUrl('/api/ai/set-key'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key, model: model })
        });
        if (resp.ok) {
          const res = await resp.json();
          if (res.success) {
            showToast("✅ Gemini API connected and saved!");
            checkAiConnection();
            aiModal.style.display = 'none';
          } else {
            showToast("Connection test failed: " + (res.message || "Unknown error"));
            checkAiConnection();
          }
        }
      } catch (err) {
        showToast("Error saving key: " + err.message);
      }
    });

    // QA Audit Modal
    const qaModal = document.getElementById('qaAuditModal');
    document.getElementById('btnRunQaAudit')?.addEventListener('click', runQaAudit);
    document.getElementById('chipQaScore')?.addEventListener('click', runQaAudit);
    document.getElementById('btnCloseQaModal')?.addEventListener('click', () => qaModal.style.display = 'none');
    document.getElementById('btnCloseQaModalBtn')?.addEventListener('click', () => qaModal.style.display = 'none');

    // AI Batch Polish
    const batchModal = document.getElementById('aiBatchReviewModal');
    document.getElementById('btnRunBatchPolish')?.addEventListener('click', runBatchPolish);
    document.getElementById('btnCloseBatchReviewModal')?.addEventListener('click', () => batchModal.style.display = 'none');
    document.getElementById('btnDiscardBatchReview')?.addEventListener('click', () => batchModal.style.display = 'none');

    document.getElementById('btnAcceptAllBatchReview')?.addEventListener('click', () => {
      if (!currentBatchSuggestions || Object.keys(currentBatchSuggestions).length === 0) {
        batchModal.style.display = 'none';
        return;
      }

      let count = 0;
      for (const sec of State.sections) {
        for (const it of (sec.items || [])) {
          const sug = currentBatchSuggestions[it.id];
          if (sug && sug.polishedComments) {
            it.comments = sug.polishedComments;
            if (sug.recommendedStatus && sug.recommendedStatus !== 'Inconclusive') it.status = sug.recommendedStatus;
            if (sug.photoCaption && it.photos && it.photos.length > 0) {
              if (!it.photos[0].caption || it.photos[0].caption === it.name) {
                it.photos[0].caption = sug.photoCaption;
              }
            }
            count++;
          }
        }
      }

      batchModal.style.display = 'none';
      State.isDirty = true;
      renderItems();
      updateMetrics();
      renderReport();
      saveActiveSession();
      showToast(`🎉 Applied AI enhancements to ${count} items!`);
    });

    // Executive Summary Modal
    const summaryModal = document.getElementById('aiSummaryModal');
    document.getElementById('btnGenerateAiSummary')?.addEventListener('click', runExecutiveSummary);
    document.getElementById('btnCloseSummaryModal')?.addEventListener('click', () => summaryModal.style.display = 'none');
    document.getElementById('btnCloseSummaryModalBtn')?.addEventListener('click', () => summaryModal.style.display = 'none');

    document.getElementById('btnCopySummaryText')?.addEventListener('click', () => {
      const content = document.getElementById('aiSummaryContent')?.innerText || '';
      if (content) {
        navigator.clipboard.writeText(content).then(() => {
          showToast("Summary copied to clipboard!");
        });
      }
    });

    // Export PDF Modal Listeners
    const exportPdfModal = document.getElementById('exportPdfModal');
    const pdfCoverFileInput = document.getElementById('pdfCoverFileInput');
    document.getElementById('btnCloseExportPdfModal')?.addEventListener('click', () => { if (exportPdfModal) exportPdfModal.style.display = 'none'; });
    document.getElementById('btnCancelExportPdf')?.addEventListener('click', () => { if (exportPdfModal) exportPdfModal.style.display = 'none'; });
    document.getElementById('btnSubmitGeneratePdf')?.addEventListener('click', submitGeneratePdf);

    document.getElementById('btnUploadCoverFile')?.addEventListener('click', () => {
      pdfCoverFileInput?.click();
    });

    pdfCoverFileInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          setCoverPhoto(evt.target.result, 'upload', `Custom Upload: ${e.target.files[0].name}`);
          document.querySelectorAll('.report-thumb-card').forEach(c => c.classList.remove('selected'));
        };
        reader.readAsDataURL(e.target.files[0]);
      }
    });

    document.getElementById('btnToggleReportPhotos')?.addEventListener('click', () => {
      const drawer = document.getElementById('reportPhotosDrawer');
      if (drawer) {
        drawer.style.display = (drawer.style.display === 'none') ? 'block' : 'none';
      }
    });

    document.getElementById('btnResetCoverPhoto')?.addEventListener('click', () => {
      setCoverPhoto(null, 'default', 'Default Bundled Hero');
      document.querySelectorAll('.report-thumb-card').forEach(c => c.classList.remove('selected'));
      showToast("Reset cover photo to default hero");
    });

    const searchInput = document.getElementById('quickNarrativeSearch');
    searchInput?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('.clean-item-card').forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = (!q || text.includes(q)) ? 'block' : 'none';
      });
    });

    if (window.lucide) lucide.createIcons();
  });

})();
