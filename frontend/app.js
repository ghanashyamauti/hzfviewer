/**
 * HZF & BIN Studio - Inspection Builder & Editor
 * Directly loads, edits, and saves .hzf, .bin, and PDF reports without HIP Desktop.
 * Full Saved Reports Library support.
 * Zero hardcoded data.
 */

(function () {
  'use strict';

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
    let base = (window.ENV && window.ENV.API_BASE_URL) || localStorage.getItem('API_BASE_URL') || '';
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
                <button class="btn btn-outline btn-sm" onclick="window.App.downloadSaved('${rep.id}', 'hzf')">.hzf</button>
                <button class="btn btn-outline btn-sm" onclick="window.App.downloadSaved('${rep.id}', 'bin')">.bin</button>
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
            imageMap[fname] = dataUrl;
          } else if (lower.endsWith('.xml') || lower.endsWith('.tpl') || lower.endsWith('.dat')) {
            const bName = fname.split('/').pop().split('\\').pop();
            const txt = await entry.async("text");
            xmlFiles[bName] = txt;
            xmlFiles[bName.toLowerCase()] = txt;
            xmlFiles[fname] = txt;
            xmlFiles[fname.toLowerCase()] = txt;
          }
        }

        // Check if this is a native Home Inspector Pro archive (.bin or .hzf with TabbedPanes/DamagePanels/ClientInfo)
        const isHipArchive = xmlFiles['tabbedpanes.tpl'] || xmlFiles['damagepanels.xml'] ||
                             xmlFiles['clientinfo.xml'] || xmlFiles['photoinfo.xml'] ||
                             xmlFiles['TabbedPanes.tpl'] || xmlFiles['DamagePanels.xml'];

        if (isHipArchive) {
          const hipParsed = parseHipFormatJs(xmlFiles, imageMap);
          State.clientInfo = hipParsed.clientInfo || {};
          State.sections = hipParsed.sections || [];
        } else {
          // Parse Generic / Standard Inspection XML
          const clientXml = xmlFiles['ClientInfo.xml'] || xmlFiles['client.xml'] || Object.values(xmlFiles)[0] || '';
          State.clientInfo = {};
          if (clientXml) {
            const dp = new DOMParser();
            const doc = dp.parseFromString(sanitizeXmlString(clientXml), "text/xml");
            const tags = ["clientName", "inspectionAddress", "inspectorName", "inspectionDate", "weather", "propertyType", "yearBuilt"];
            tags.forEach(t => {
              const el = doc.querySelector(t) || doc.querySelector(t.toLowerCase());
              if (el) State.clientInfo[t] = el.textContent.trim();
            });
          }

          const inspXml = xmlFiles['InspectionData.xml'] || xmlFiles['report.xml'];
          const parsedSections = [];

          if (inspXml) {
            const dp = new DOMParser();
            const doc = dp.parseFromString(sanitizeXmlString(inspXml), "text/xml");
            doc.querySelectorAll('Section').forEach((sNode, sIdx) => {
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
                  if (pFile && imageMap[pFile]) {
                    photos.push({ filename: pFile, dataUrl: imageMap[pFile], caption: pCap });
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
          }

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
        }

        State.activeSectionId = State.sections[0] ? State.sections[0].id : null;
        setWorkspaceActive(true);
        showToast(`Loaded ${file.name}!`);
      } catch (err) {
        showToast("Error reading file: " + err.message);
      }
    }
  }

  // Export File (supports both .hzf and .bin)
  async function exportFile(format = 'hzf') {
    syncFormToState();
    const isBin = (format === 'bin');
    const endpoint = isBin ? '/api/export-bin' : '/api/export-hzf';
    let outName = State.fileName || "Inspection_Report";
    outName = outName.replace(/\.[^/.]+$/, "") + (isBin ? '.bin' : '.hzf');

    showToast(`Generating ${outName}...`);

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: State.activeReportId,
          fileName: outName,
          clientInfo: State.clientInfo,
          sections: State.sections
        })
      });

      if (resp.ok) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`Saved ${outName}!`);
        return;
      }
    } catch (e) {
      console.log("Backend export failed, attempting client-side fallback...");
    }

    // Client-side fallback if backend unavailable
    if (window.JSZip) {
      const zip = new JSZip();
      zip.file("ClientInfo.xml", `<ClientData><Address>${State.clientInfo.inspectionAddress || ''}</Address></ClientData>`);
      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = outName;
      a.click();
      showToast(`Saved ${outName}!`);
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
            <button type="button" class="btn-polish-item" onclick="window.App.polishItem('${sec.id}', '${item.id}')" title="AI Polish this field note">
              <i data-lucide="sparkles" style="width: 12px; height: 12px;"></i>
              <span>AI Polish</span>
            </button>
          </div>
          <textarea class="clean-textarea" id="notes_${item.id}"
            placeholder="Add inspector notes, defect findings, or repair recommendations..."
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

  // Sync Form Input fields to State
  function syncFormToState() {
    State.clientInfo = {
      inspectionAddress: document.getElementById('formAddress')?.value || '',
      propertyType: document.getElementById('formPropertyType')?.value || '',
      yearBuilt: document.getElementById('formYearBuilt')?.value || '',
      squareFootage: document.getElementById('formSqFt')?.value || '',
      weather: document.getElementById('formWeather')?.value || '',
      clientName: document.getElementById('formClientName')?.value || '',
      clientPhone: document.getElementById('formClientPhone')?.value || '',
      clientEmail: document.getElementById('formClientEmail')?.value || '',
      inspectionDate: document.getElementById('formInspectionDate')?.value || '',
      inspectionTime: document.getElementById('formInspectionTime')?.value || '',
      inspectorName: document.getElementById('formInspectorName')?.value || '',
      inspectorLicense: document.getElementById('formInspectorLicense')?.value || '',
      inspectionCompany: document.getElementById('formCompanyName')?.value || ''
    };
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

  // Render Printable Report
  function renderReport() {
    const sheet = document.getElementById('reportSheet');
    if (!sheet) return;

    const c = State.clientInfo || {};
    let secHtml = '';

    State.sections.forEach(sec => {
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
            photosGrid += `
              <div class="report-photo-box">
                <img src="${p.dataUrl}" alt="${p.filename}">
                <div class="report-photo-caption">${p.caption || it.name}</div>
              </div>
            `;
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

    sheet.innerHTML = `
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

    // Polish a single item's field note using Gemini AI
    polishItem: async function (secId, itemId) {
      const sec = State.sections.find(s => s.id === secId);
      const it = sec?.items.find(i => i.id === itemId);
      if (!it) return;

      const raw = (it.comments || '').trim();
      if (!raw) {
        showToast("Please enter an inspector observation first.");
        return;
      }

      showToast("✨ AI polishing narrative...");
      try {
        const resp = await fetch(apiUrl('/api/ai/polish-item'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sectionName: sec.name,
            itemName: it.name,
            status: it.status,
            rawComments: raw,
            photosCount: (it.photos || []).length
          })
        });

        if (resp.ok) {
          const res = await resp.json();
          if (res.success && res.polished) {
            it.comments = res.polished;
            if (res.recommendedStatus) it.status = res.recommendedStatus;
            renderItems();
            updateMetrics();
            renderReport();
            showToast("✨ Narrative polished with InterNACHI standards!");
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

  // Direct PDF Report Downloader
  async function downloadPdfReport() {
    showToast("Preparing PDF report...");
    syncFormToState();

    // 1. Remember user's current active tab so we can restore it seamlessly
    const currentActiveTab = document.querySelector('.nav-tab.active')?.getAttribute('data-tab') || 'checklist';
    const tabReport = document.getElementById('tabReport');
    const tabChecklist = document.getElementById('tabChecklist');
    const tabProperty = document.getElementById('tabProperty');

    // 2. Temporarily switch to the Report Preview tab so all CSS layout, table widths, and dimensions are fully computed
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.nav-tab[data-tab="report"]')?.classList.add('active');

    if (tabChecklist) tabChecklist.style.display = 'none';
    if (tabProperty) tabProperty.style.display = 'none';
    if (tabReport) tabReport.style.display = 'block';

    // 3. Render the fresh report sheet
    renderReport();

    const reportElem = document.getElementById('reportSheet');
    if (!reportElem) {
      showToast("Report sheet not found");
      return;
    }

    // 4. Wait for DOM paint and images to decode
    await new Promise(r => setTimeout(r, 400));

    // Ensure report element has visible dimensions
    if (reportElem.offsetHeight === 0) {
      reportElem.style.display = 'block';
      reportElem.style.visibility = 'visible';
    }

    const cleanBase = (State.fileName || 'Inspection_Report').replace(/\.[^/.]+$/, "");
    const pdfFilename = `${cleanBase}_Report.pdf`;

    if (window.html2pdf) {
      showToast("Rendering PDF document...");
      // Dynamically calculate scale so the rendered canvas NEVER exceeds browser's 65,535px maximum limit
      const elemHeight = Math.max(reportElem.scrollHeight, reportElem.offsetHeight, 1000);
      const safeScale = Math.min(1.8, Math.max(1.0, 48000 / elemHeight));

      const opt = {
        margin: [10, 10, 10, 10],
        filename: pdfFilename,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: safeScale,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff'
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] }
      };

      try {
        await html2pdf().set(opt).from(reportElem).save();
        showToast(`✅ Downloaded ${pdfFilename}!`);

        // If user was on another tab, restore it after a short delay
        if (currentActiveTab !== 'report') {
          setTimeout(() => {
            const prevTabBtn = document.querySelector(`.nav-tab[data-tab="${currentActiveTab}"]`);
            if (prevTabBtn) prevTabBtn.click();
          }, 800);
        }
        return;
      } catch (err) {
        console.warn("Direct html2pdf export failed, switching to native vector print fallback:", err);
      }
    }

    // High-fidelity fallback: Browser native vector print to PDF
    showToast("Opening Print / Save as PDF dialog...");
    setTimeout(() => window.print(), 300);
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
          inspectionDate: 'inspectionDate',
          weather: 'weather',
          propertyType: 'otherInfo'
        };
        for (const [k, prop] of Object.entries(cMap)) {
          if (State.clientInfo[k]) {
            clientXml += `  <void property="${prop}"><string>${State.clientInfo[k]}</string></void>\n`;
          }
        }
        clientXml += `</object>\n</java>`;
        zip.file("ClientInfo.xml", clientXml);

        // 2. TabbedPanes.tpl
        let tplXml = `<?xml version="1.0" encoding="UTF-8"?>\n<java version="1.8.0_131" class="java.beans.XMLDecoder">\n<object class="homeinspectorpro.TemplateInfo">\n`;
        (State.sections || []).forEach(sec => {
          tplXml += `  <void property="tabbedPaneName"><string>${sec.name}</string></void>\n`;
        });
        tplXml += `</object>\n</java>`;
        zip.file("TabbedPanes.tpl", tplXml);

        // 3. DamagePanels.xml
        let dmgXml = `<?xml version="1.0" encoding="UTF-8"?>\n<java version="1.8.0_131" class="java.beans.XMLDecoder">\n`;
        (State.sections || []).forEach(sec => {
          (sec.items || []).forEach(it => {
            const fullName = `${sec.name}${it.name}`;
            dmgXml += `  <object class="homeinspectorpro.DamagePanelInfo">\n`;
            dmgXml += `    <void property="name"><string>${fullName}</string></void>\n`;
            if (it.status === 'Safety Hazard' || it.status === 'Defective') {
              dmgXml += `    <void property="damageStatusRedVector"><void method="add"><string>${it.comments || it.status}</string></void></void>\n`;
            } else if (it.status === 'Marginal') {
              dmgXml += `    <void property="damageStatusBlackVector"><void method="add"><string>${it.comments || it.status}</string></void></void>\n`;
            } else if (it.comments) {
              dmgXml += `    <void property="damageStatusVector"><void method="add"><string>${it.comments}</string></void></void>\n`;
            }
            dmgXml += `  </object>\n`;
          });
        });
        dmgXml += `</java>`;
        zip.file("DamagePanels.xml", dmgXml);

        // 4. PhotoInfo.xml & Photos
        let photoXml = `<?xml version="1.0" encoding="UTF-8"?>\n<java version="1.8.0_131" class="java.beans.XMLDecoder">\n`;
        const writtenPhotos = new Set();

        (State.sections || []).forEach(sec => {
          (sec.items || []).forEach(it => {
            (it.photos || []).forEach(p => {
              const fname = p.filename || `photo_${writtenPhotos.size + 1}.jpg`;
              photoXml += `  <object class="homeinspectorpro.PhotoInfo">\n`;
              photoXml += `    <void property="fileName"><string>${fname}</string></void>\n`;
              photoXml += `    <void property="areaName"><string>${sec.name}</string></void>\n`;
              photoXml += `    <void property="itemName"><string>${it.name}</string></void>\n`;
              photoXml += `    <void property="caption"><string>${p.caption || ''}</string></void>\n`;
              photoXml += `  </object>\n`;

              if (p.dataUrl && !writtenPhotos.has(fname)) {
                writtenPhotos.add(fname);
                const base64Data = p.dataUrl.includes(',') ? p.dataUrl.split(',')[1] : p.dataUrl;
                zip.file(fname, base64Data, { base64: true });
              }
            });
          });
        });
        photoXml += `</java>`;
        zip.file("PhotoInfo.xml", photoXml);

        // 5. Standard InspectionData.xml for cross-compatibility
        let inspXml = `<InspectionReport created="${new Date().toISOString()}"><Sections>`;
        (State.sections || []).forEach(s => {
          inspXml += `<Section id="${s.id}" name="${s.name}"><Summary>${s.desc||s.summary||''}</Summary><Items>`;
          (s.items || []).forEach(it => {
            inspXml += `<Item id="${it.id}" name="${it.name}"><Status>${it.status}</Status><Comments>${it.comments||''}</Comments><Photos>`;
            (it.photos || []).forEach(p => {
              inspXml += `<Photo filename="${p.filename}" caption="${p.caption||''}"/>`;
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
    document.getElementById('btnSaveHzf')?.addEventListener('click', () => exportFile('hzf'));
    document.getElementById('btnSaveBin')?.addEventListener('click', () => exportFile('bin'));

    const printRepBtn = document.getElementById('btnPrintReport');
    if (printRepBtn) {
      printRepBtn.addEventListener('click', () => {
        document.querySelector('.nav-tab[data-tab="report"]')?.click();
        setTimeout(() => window.print(), 250);
      });
    }

    const printPdfOld = document.getElementById('btnPrintPdf');
    if (printPdfOld) printPdfOld.addEventListener('click', downloadPdfReport);

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
            if (sug.recommendedStatus) it.status = sug.recommendedStatus;
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
