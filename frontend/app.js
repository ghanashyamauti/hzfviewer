/**
 * HZF & BIN Studio - Inspection Builder & Editor
 * Directly loads, edits, and saves .hzf, .bin, and PDF reports without HIP Desktop.
 * Full Saved Reports Library support.
 * Zero hardcoded data.
 */

(function () {
  'use strict';

  console.log("app.js build 2026-10-15T16:25:00-debug");

  const State = {
    isInspectionActive: false,
    activeReportId: null,
    fileName: "Untitled_Inspection.hzf",
    clientInfo: {},
    sections: [],
    activeSectionId: null,
    activePhotoTarget: null // { secId, itemId, photoIdx }
  };

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

  // Toast Notification Helper
  function showToast(msg) {
    const t = document.getElementById('toastMessage');
    if (!t) return;
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  // Switch between Welcome Hub and Active Inspection Workspace
  function setWorkspaceActive(active, pushState = true) {
    State.isInspectionActive = active;
    document.body.classList.toggle('workspace-active', active);

    const welcome = document.getElementById('welcomeScreen');
    const workspace = document.getElementById('activeWorkspace');
    const navTabs = document.getElementById('navCenterTabs');
    const exportGrp = document.getElementById('exportGroup');
    const navBack = document.getElementById('btnNavBack');

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

  // Back Navigation Helper to return to Welcome Dashboard
  function goBackHome() {
    if (window.location.hash === '#workspace') {
      window.history.back();
    } else {
      setWorkspaceActive(false, false);
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
                <h4>${rep.address || 'Untitled Property'}</h4>
                <p>Client: <strong>${rep.clientName || 'N/A'}</strong> • Saved: <strong>${rep.savedAt || rep.inspectionDate || 'Recently'}</strong></p>
                <div class="saved-report-badges">
                  ${rep.hazards > 0 ? `<span class="mini-badge" style="background:var(--hazard-bg);color:var(--hazard-color);">${rep.hazards} Hazards</span>` : ''}
                  ${rep.defects > 0 ? `<span class="mini-badge" style="background:var(--defect-bg);color:var(--defect-color);">${rep.defects} Defects</span>` : ''}
                  <span class="mini-badge" style="background:var(--bg-subtle);color:var(--text-muted);">${rep.totalItems} Items</span>
                  <span class="mini-badge" style="background:var(--bg-subtle);color:var(--text-muted);">${rep.photoCount} Photos</span>
                </div>
              </div>
              <div class="saved-report-actions">
                <button class="btn btn-primary btn-sm" onclick="window.App.openSaved('${rep.id}')">Open</button>
                <button class="btn btn-outline btn-sm" onclick="window.App.downloadSaved('${rep.id}', 'pdf')" title="Download exact PDF report">PDF</button>
                <button class="btn btn-outline btn-sm" onclick="window.App.downloadSaved('${rep.id}', 'hzf')" title="Download .hzf archive">.hzf</button>
                <button class="btn btn-outline btn-sm" onclick="window.App.downloadSaved('${rep.id}', 'bin')" title="Download .bin container">.bin</button>
                <button class="btn btn-danger btn-sm" onclick="window.App.deleteSaved('${rep.id}')" title="Delete Report">&times;</button>
              </div>
            `;
            listEl.appendChild(item);
          });
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
          refreshSavedReportsCount();
          showToast("Inspection saved to library!");
          return;
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
      showToast("Saved to browser storage!");
    } catch (err) {
      showToast("Error saving: " + err.message);
    }
  }

  // Start Blank Inspection Template (Zero Hardcoded Data)
  async function startBlankInspection() {
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
          setWorkspaceActive(true);
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
    setWorkspaceActive(true);
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
          setWorkspaceActive(true);
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
          const hipResult = parseHomeInspectorProZip(xmlFiles, imageMap);
          State.clientInfo = hipResult.clientInfo || {};
          State.sections = hipResult.sections || [];
        }

        State.activeSectionId = State.sections[0] ? State.sections[0].id : null;
        setWorkspaceActive(true);
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
          <button class="btn-upload-photo" onclick="document.getElementById('up_${item.id}').click()" title="Attach photo from mobile or computer">
            <i data-lucide="camera"></i>
            <span>+ Photo</span>
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

  // Pure function to generate clean, consistent inspection report HTML
  function generateReportHtml(clientInfo, sections) {
    const c = clientInfo || {};
    let secHtml = '';

    (sections || []).forEach(sec => {
      secHtml += `<div class="report-sec-head">${sec.name}</div>`;

      (sec.items || []).forEach(it => {
        let rowClass = '';
        if (it.status === 'Safety Hazard') rowClass = 'row-hazard';
        else if (it.status === 'Defective') rowClass = 'row-defect';
        else if (it.status === 'Marginal') rowClass = 'row-marginal';

        let photosGrid = '';
        if (it.photos && it.photos.length > 0) {
          photosGrid += `<div class="report-photos-grid">`;
          it.photos.forEach(p => {
            if (p.dataUrl) {
              photosGrid += `
                <div class="report-photo-box">
                  <img src="${p.dataUrl}" alt="${p.filename || 'Inspection Photo'}">
                  <div class="report-photo-caption">${p.caption || it.name}</div>
                </div>
              `;
            }
          });
          photosGrid += `</div>`;
        }

        secHtml += `
          <div class="report-row ${rowClass}">
            <div class="report-row-title">
              <span>${it.name}</span>
              <span style="font-size: 0.75rem; text-transform: uppercase;">${it.status}</span>
            </div>
            ${it.comments ? `<div class="report-row-desc">${it.comments}</div>` : ''}
            ${photosGrid}
          </div>
        `;
      });
    });

    return `
      <div class="report-sheet-head">
        <div>
          <h1 class="report-sheet-title">HOME INSPECTION REPORT</h1>
          <p class="report-sheet-sub">${c.inspectionCompany || 'Inspection Services'} • ${c.inspectorLicense || ''}</p>
        </div>
        <div style="text-align: right; font-size: 0.8125rem;">
          <div><strong>Date:</strong> ${c.inspectionDate || ''}</div>
          <div><strong>Inspector:</strong> ${c.inspectorName || ''}</div>
        </div>
      </div>

      <table class="report-table">
        <tr>
          <td class="strong">Client:</td>
          <td>${c.clientName || 'N/A'}</td>
          <td class="strong">Address:</td>
          <td>${c.inspectionAddress || 'N/A'}</td>
        </tr>
        <tr>
          <td class="strong">Property Type:</td>
          <td>${c.propertyType || 'Residential'}</td>
          <td class="strong">Year / SqFt:</td>
          <td>${c.yearBuilt || 'N/A'} • ${c.squareFootage || 'N/A'}</td>
        </tr>
      </table>

      ${secHtml}
    `;
  }

  // Render Printable Report inside workspace tab
  function renderReport() {
    const sheet = document.getElementById('reportSheet');
    if (!sheet) return;
    sheet.innerHTML = generateReportHtml(State.clientInfo, State.sections);
  }

  function renderAll() {
    renderPropertyForm();
    renderSidebar();
    renderItems();
    updateMetrics();
    renderReport();
  }

  // Public App Handlers
  window.App = {
    setStatus: function (secId, itemId, status) {
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it) {
        it.status = status;
        renderItems();
        updateMetrics();
        renderSidebar();
        renderReport();
      }
    },

    setComments: function (secId, itemId, comments) {
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it) {
        it.comments = comments;
        renderReport();
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
          renderItems();
          renderReport();
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
            document.getElementById('savedReportsModal').style.display = 'none';
            setWorkspaceActive(true);
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
              await downloadPdfReport(json.data);
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
              a.href = url;
              a.download = (json.data.fileName || 'Report').replace(/\.[^/.]+$/, "") + '.' + format;
              a.click();
              URL.revokeObjectURL(url);
              showToast(`Downloaded .${format}!`);
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
            renderItems();
            updateMetrics();
            renderReport();
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

  // Direct PDF Report Downloader (jsPDF vector rendering — no html2canvas)
  async function downloadPdfReport(targetData = null) {
    showToast("Generating PDF report...");

    let clientInfo, sections, fileName;
    if (targetData) {
      clientInfo = targetData.clientInfo || {};
      sections = targetData.sections || [];
      fileName = targetData.fileName || 'Inspection_Report';
    } else {
      syncFormToState();
      clientInfo = State.clientInfo || {};
      sections = State.sections || [];
      fileName = State.fileName || 'Inspection_Report';
    }

    const cleanBase = (fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
    const pdfFilename = `${cleanBase}_Report.pdf`;

    // [STEP 2b] Log at the start
    const jsPDFClass = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    console.log("DEBUG: jsPDF check:", {
      typeof_window_jspdf: typeof window.jspdf,
      typeof_window_jspdf_jsPDF: typeof window.jspdf?.jsPDF,
      typeof_window_jsPDF: typeof window.jsPDF,
      jsPDF_version: window.jspdf?.version || jsPDFClass?.version || "unknown"
    });

    if (!jsPDFClass) {
      const err = new Error("jsPDF library is not loaded or missing on window");
      console.error("DEBUG: Missing jsPDF fallback error:", err.stack);
      showToast("Error: " + err.message);
      return;
    }

    // [STEP 2c] Log the input
    const allItems = (sections || []).flatMap(s => s.items || []);
    const allPhotosWithDataUrl = allItems.flatMap(i => (i.photos || []).filter(p => !!p.dataUrl));
    console.log("DEBUG: PDF Input Data:", {
      numberOfSections: (sections || []).length,
      totalNumberOfItems: allItems.length,
      numberOfPhotosWithDataUrl: allPhotosWithDataUrl.length,
      first3Photos: allPhotosWithDataUrl.slice(0, 3).map((p, idx) => ({
        index: idx,
        dataUrlPrefix: (p.dataUrl || '').substring(0, 30),
        dataUrlLength: (p.dataUrl || '').length
      }))
    });

    try {
      const pdf = new jsPDFClass({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();   // ~210
      const pageH = pdf.internal.pageSize.getHeight();  // ~297
      const M = 15; // margin
      const cW = pageW - M * 2; // content width ~180
      let y = M;

      // Colors
      const BLACK = [15, 23, 42];
      const GRAY = [100, 116, 139];
      const LIGHT = [226, 232, 240];
      const ACCENT = [99, 102, 241];
      const WHITE = [255, 255, 255];
      const BG_LIGHT = [248, 250, 252];

      const STATUS_COLORS = {
        'Safety Hazard': { border: [225, 29, 72], bg: [255, 241, 242] },
        'Safety': { border: [225, 29, 72], bg: [255, 241, 242] },
        'Defective': { border: [234, 88, 12], bg: [255, 247, 237] },
        'Defects': { border: [234, 88, 12], bg: [255, 247, 237] },
        'Marginal': { border: [217, 119, 6], bg: [255, 251, 235] },
        'Satisfactory': { border: [22, 163, 74], bg: [240, 253, 244] },
        'Good': { border: [22, 163, 74], bg: [240, 253, 244] },
        'Not Inspected': { border: [148, 163, 184], bg: [248, 250, 252] },
        'Not Present': { border: [148, 163, 184], bg: [248, 250, 252] },
      };

      function checkPage(needed) {
        if (y + needed > pageH - M) {
          pdf.addPage();
          y = M;
          return true;
        }
        return false;
      }

      // Helper: wrap text and return lines
      function getLines(text, maxWidth, fontSize) {
        pdf.setFontSize(fontSize);
        return pdf.splitTextToSize(text || '', maxWidth);
      }

      // ========== HEADER ==========
      pdf.setFillColor(...ACCENT);
      pdf.rect(0, 0, pageW, 28, 'F');
      pdf.setTextColor(...WHITE);
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text('HOME INSPECTION REPORT', M, 13);
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      const company = clientInfo.inspectionCompany || 'Inspection Services';
      const license = clientInfo.inspectorLicense || '';
      pdf.text(`${company}${license ? '  •  ' + license : ''}`, M, 20);

      // Date & Inspector on right
      pdf.setFontSize(9);
      const dateStr = `Date: ${clientInfo.inspectionDate || 'N/A'}`;
      const inspStr = `Inspector: ${clientInfo.inspectorName || 'N/A'}`;
      pdf.text(dateStr, pageW - M, 13, { align: 'right' });
      pdf.text(inspStr, pageW - M, 20, { align: 'right' });

      y = 35;

      // ========== CLIENT INFO TABLE ==========
      const c = clientInfo;
      const infoRows = [
        ['Client', c.clientName || 'N/A', 'Address', c.inspectionAddress || 'N/A'],
        ['Property Type', c.propertyType || 'Residential', 'Year / SqFt',
          `${c.yearBuilt || 'N/A'}  •  ${c.squareFootage || 'N/A'}`]
      ];

      pdf.setDrawColor(...LIGHT);
      pdf.setFillColor(...BG_LIGHT);

      const colWidths = [32, cW / 2 - 32, 32, cW / 2 - 32];
      const rowH = 8;

      infoRows.forEach(row => {
        checkPage(rowH + 2);
        let x = M;
        row.forEach((cell, ci) => {
          if (ci % 2 === 0) {
            // Label cell
            pdf.setFillColor(...BG_LIGHT);
            pdf.rect(x, y, colWidths[ci], rowH, 'FD');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(8);
            pdf.setTextColor(...BLACK);
            pdf.text(cell, x + 2, y + 5.5);
          } else {
            // Value cell
            pdf.setFillColor(...WHITE);
            pdf.rect(x, y, colWidths[ci], rowH, 'FD');
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            pdf.setTextColor(...BLACK);
            const valLines = pdf.splitTextToSize(cell, colWidths[ci] - 4);
            pdf.text(valLines[0] || '', x + 2, y + 5.5);
          }
          x += colWidths[ci];
        });
        y += rowH;
      });

      y += 8;

      // ========== SECTIONS & ITEMS ==========
      (sections || []).forEach(sec => {
        // Section header
        checkPage(14);
        pdf.setFillColor(...ACCENT);
        pdf.rect(M, y, cW, 9, 'F');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(11);
        pdf.setTextColor(...WHITE);
        pdf.text(sec.name || 'Section', M + 4, y + 6.5);
        y += 12;

        (sec.items || []).forEach(it => {
          const status = it.status || 'Not Inspected';
          const sc = STATUS_COLORS[status] || STATUS_COLORS['Not Inspected'];
          const comments = it.comments || '';
          const photos = (it.photos || []).filter(p => p.dataUrl);

          // Calculate needed height
          const commentLines = comments ? getLines(comments, cW - 14, 8) : [];
          let itemH = 10; // title row
          if (commentLines.length > 0) itemH += commentLines.length * 3.5 + 2;
          if (photos.length > 0) itemH += 45; // photo row height

          checkPage(Math.min(itemH + 4, 80)); // don't exceed page

          // Item background
          pdf.setFillColor(...sc.bg);
          const bgH = Math.min(itemH, pageH - M - y);
          pdf.rect(M, y, cW, bgH, 'F');

          // Left border
          pdf.setFillColor(...sc.border);
          pdf.rect(M, y, 2.5, bgH, 'F');

          // Item name
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(9);
          pdf.setTextColor(...BLACK);
          pdf.text(it.name || 'Item', M + 6, y + 6);

          // Status badge
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(7);
          pdf.setTextColor(...sc.border);
          pdf.text(status.toUpperCase(), pageW - M - 4, y + 6, { align: 'right' });

          y += 10;

          // Comments
          if (commentLines.length > 0) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            pdf.setTextColor(51, 65, 85);
            commentLines.forEach(line => {
              checkPage(5);
              pdf.text(line, M + 6, y);
              y += 3.5;
            });
            y += 1;
          }

          // Photos
          if (photos.length > 0) {
            let px = M + 6;
            const photoW = (cW - 16) / Math.min(photos.length, 3);
            const photoH = 38;

            checkPage(photoH + 6);

            photos.slice(0, 6).forEach((p, pi) => {
              if (pi > 0 && pi % 3 === 0) {
                // New row
                px = M + 6;
                y += photoH + 4;
                checkPage(photoH + 6);
              }

              try {
                // Determine image format from dataUrl
                let fmt = 'JPEG';
                if (p.dataUrl.includes('image/png')) fmt = 'PNG';

                pdf.addImage(p.dataUrl, fmt, px, y, photoW - 4, photoH - 6);

                // Caption
                pdf.setFont('helvetica', 'italic');
                pdf.setFontSize(6);
                pdf.setTextColor(...GRAY);
                const caption = (p.caption || p.filename || it.name || '').substring(0, 30);
                pdf.text(caption, px, y + photoH - 4);
              } catch (imgErr) {
                // [STEP 2e] Wrap each pdf.addImage call to log real error
                console.error("DEBUG: pdf.addImage failed:", {
                  format: p.dataUrl.includes('image/png') ? 'PNG' : 'JPEG',
                  dataUrlPrefix: (p.dataUrl || '').substring(0, 30),
                  dataUrlLength: (p.dataUrl || '').length,
                  errorMessage: imgErr.message,
                  errorStack: imgErr.stack
                });
                pdf.setFont('helvetica', 'italic');
                pdf.setFontSize(7);
                pdf.setTextColor(...GRAY);
                pdf.text('[Image Error]', px + 2, y + 10);
              }

              px += photoW;
            });

            y += photoH + 2;
          }

          y += 3; // gap between items
        });

        y += 4; // gap between sections
      });

      // ========== FOOTER LINE ==========
      checkPage(15);
      y += 5;
      pdf.setDrawColor(...LIGHT);
      pdf.line(M, y, pageW - M, y);
      y += 5;
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(7);
      pdf.setTextColor(...GRAY);
      pdf.text(`Generated by HZF Inspector Studio  •  ${new Date().toLocaleDateString()}`, M, y);

      // Add page numbers
      const totalPages = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7);
        pdf.setTextColor(...GRAY);
        pdf.text(`Page ${i} of ${totalPages}`, pageW - M, pageH - 8, { align: 'right' });
      }

      // [STEP 2d] Log right before pdf.save()
      const blobSize = pdf.output('blob').size;
      const finalPages = pdf.internal.getNumberOfPages();
      console.log("DEBUG: PDF Pre-Save Stats:", {
        numberOfPages: finalPages,
        finalValueOfY: y,
        blobSizeBytes: blobSize
      });

      pdf.save(pdfFilename);
      showToast(`✅ Downloaded ${pdfFilename}!`);

    } catch (err) {
      // [STEP 2a] Remove window.print fallback, log full stack and show toast with err.message
      console.error("DEBUG: PDF generation exception caught:", err.stack || err);
      showToast(`PDF Error: ${err.message}`);
    }
  }

  // Fast Export for .hzf and .bin containers
  async function exportFile(format) {
    showToast(`Generating .${format} download...`);
    syncFormToState();
    const cleanBase = (State.fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
    const downloadName = `${cleanBase}.${format}`;

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
          if (State.clientInfo[k]) {
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
                if (p.dataUrl.includes(',')) {
                  const base64Data = p.dataUrl.split(',')[1];
                  zip.file(cleanFname, base64Data, { base64: true });
                } else if (p.dataUrl.startsWith('blob:') || p.dataUrl.startsWith('http')) {
                  try {
                    const imgResp = await fetch(p.dataUrl);
                    const imgBlob = await imgResp.blob();
                    zip.file(cleanFname, imgBlob);
                  } catch (e) {
                    console.warn("Failed to fetch photo blob:", e);
                  }
                } else {
                  zip.file(cleanFname, p.dataUrl, { base64: true });
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

        // FAST GENERATE using STORE (instant packaging without heavy re-compression of JPEGs)
        const blob = await zip.generateAsync({
          type: "blob",
          compression: "STORE"
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`Downloaded ${downloadName}!`);
        return;
      } catch (err) {
        console.warn("Client export warning:", err);
      }
    }

    // Backend export fallback if JSZip not available
    try {
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
      if (resp.ok) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`Downloaded ${downloadName}!`);
      }
    } catch (e) {
      showToast("Download failed: " + e.message);
    }
  }

  // DOM Event Listeners  // DOM Event Listeners
  document.addEventListener('DOMContentLoaded', () => {

    // Listen to browser Back / Forward history navigation
    window.addEventListener('popstate', (e) => {
      const isWorkspaceHash = (window.location.hash === '#workspace');
      if (isWorkspaceHash) {
        if (!State.isInspectionActive) {
          setWorkspaceActive(true, false);
        }
      } else {
        if (State.isInspectionActive) {
          setWorkspaceActive(false, false);
        }
      }
    });

    // Initial state: Clean Welcome Screen (Zero Hardcoded Data)
    if (window.location.hash === '#workspace') {
      history.replaceState({ view: 'home' }, '', window.location.pathname + window.location.search);
    }
    setWorkspaceActive(false, false);

    // Dedicated Back Buttons
    const navBackBtn = document.getElementById('btnNavBack');
    if (navBackBtn) navBackBtn.addEventListener('click', goBackHome);

    const heroBackBtn = document.getElementById('btnHeroBack');
    if (heroBackBtn) heroBackBtn.addEventListener('click', goBackHome);

    // Brand Home Button
    const brandBtn = document.getElementById('brandHomeBtn');
    if (brandBtn) {
      brandBtn.addEventListener('click', () => {
        if (State.isInspectionActive) {
          goBackHome();
        }
      });
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
    document.getElementById('btnOpenSavedReports')?.addEventListener('click', () => {
      loadSavedReportsModal();
      if (savedModal) savedModal.style.display = 'flex';
    });
    document.getElementById('btnCloseSavedReportsModal')?.addEventListener('click', () => { if (savedModal) savedModal.style.display = 'none'; });
    document.getElementById('btnDismissSavedReports')?.addEventListener('click', () => { if (savedModal) savedModal.style.display = 'none'; });

    // Save and Export Triggers
    document.getElementById('btnSaveToLibrary')?.addEventListener('click', saveActiveReport);
    document.getElementById('btnSavePdf')?.addEventListener('click', () => downloadPdfReport());
    document.getElementById('btnSaveHzf')?.addEventListener('click', () => exportFile('hzf'));
    document.getElementById('btnSaveBin')?.addEventListener('click', () => exportFile('bin'));

    // In Report Tab: Direct PDF download
    document.getElementById('btnDownloadPdfTab')?.addEventListener('click', () => downloadPdfReport());

    const printRepBtn = document.getElementById('btnPrintReport');
    if (printRepBtn) {
      printRepBtn.addEventListener('click', () => {
        document.querySelector('.nav-tab[data-tab="report"]')?.click();
        setTimeout(() => window.print(), 250);
      });
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

    // Dismiss export dropdown when selecting an export action
    document.querySelectorAll('#exportDropdownMenu .dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        if (exportContainer) exportContainer.classList.remove('open');
      });
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
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-tab');

        const tabC = document.getElementById('tabChecklist');
        const tabP = document.getElementById('tabProperty');
        const tabR = document.getElementById('tabReport');
        if (tabC) tabC.style.display = (target === 'checklist') ? 'flex' : 'none';
        if (tabP) tabP.style.display = (target === 'property') ? 'block' : 'none';
        if (tabR) tabR.style.display = (target === 'report') ? 'block' : 'none';

        if (target === 'report') renderReport();
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
        addItemModal.style.display = 'none';
        renderItems();
        updateMetrics();
        renderSidebar();
        renderReport();
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
      addSectionModal.style.display = 'none';
      renderSidebar();
      renderItems();
      renderReport();
      showToast(`Created section "${name}"`);
    });

    // Photo Modal Controls
    const photoModal = document.getElementById('photoModal');
    document.getElementById('btnClosePhotoModal')?.addEventListener('click', () => { if (photoModal) photoModal.style.display = 'none'; });
    document.getElementById('btnCancelPhotoModal')?.addEventListener('click', () => { if (photoModal) photoModal.style.display = 'none'; });

    document.getElementById('btnSavePhotoCaption')?.addEventListener('click', () => {
      if (!State.activePhotoTarget) return;
      const { secId, itemId, photoIdx } = State.activePhotoTarget;
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it && it.photos[photoIdx]) {
        it.photos[photoIdx].caption = document.getElementById('photoModalCaption')?.value.trim() || '';
        renderItems();
        renderReport();
        showToast("Caption updated");
      }
      if (photoModal) photoModal.style.display = 'none';
    });

    document.getElementById('btnDeletePhoto')?.addEventListener('click', () => {
      if (!State.activePhotoTarget) return;
      const { secId, itemId, photoIdx } = State.activePhotoTarget;
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (it && it.photos) {
        it.photos.splice(photoIdx, 1);
        renderItems();
        renderReport();
        showToast("Photo deleted");
      }
      if (photoModal) photoModal.style.display = 'none';
    });

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
      renderItems();
      updateMetrics();
      renderReport();
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

    if (window.lucide) lucide.createIcons();
  });

})();
