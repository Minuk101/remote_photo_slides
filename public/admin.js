const state = {
  rootName: '사진',
  currentPath: '',
  selected: new Set()
};

const elements = {
  serverDot: document.getElementById('server-dot'),
  serverStatus: document.getElementById('server-status'),
  rootPath: document.getElementById('root-path'),
  locationStatus: document.getElementById('location-status'),
  breadcrumbs: document.getElementById('breadcrumbs'),
  folderList: document.getElementById('folder-list'),
  selectCurrent: document.getElementById('select-current'),
  selectedList: document.getElementById('selected-list'),
  selectedCount: document.getElementById('selected-count'),
  saveButton: document.getElementById('save-selection'),
  saveMessage: document.getElementById('save-message')
};

async function refreshLocationStatus() {
  try {
    const status = await api('/api/location-status');
    const progress = status.total ? ` · ${status.checked.toLocaleString()}/${status.total.toLocaleString()}장` : '';
    const gps = status.gps ? ` · GPS ${status.gps.toLocaleString()}장` : '';
    elements.locationStatus.textContent = `${status.phase}${progress}${gps}`;
  } catch {
    elements.locationStatus.textContent = '위치 기능 상태를 확인할 수 없습니다.';
  }
}

async function api(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '서버 요청에 실패했습니다.');
  return result;
}

function displayPath(value) {
  return value ? `${state.rootName} / ${value}` : state.rootName;
}

function isCoveredBySelection(folder) {
  for (const selected of state.selected) {
    if (selected === '' || folder === selected || folder.startsWith(`${selected}/`)) return true;
  }
  return false;
}

function toggleSelection(folder) {
  if (state.selected.has(folder)) {
    state.selected.delete(folder);
  } else if (!isCoveredBySelection(folder)) {
    for (const selected of [...state.selected]) {
      if (folder === '' || selected.startsWith(`${folder}/`)) state.selected.delete(selected);
    }
    state.selected.add(folder);
  }
  renderSelected();
  loadFolder(state.currentPath);
}

function renderBreadcrumbs() {
  elements.breadcrumbs.replaceChildren();
  const parts = state.currentPath ? state.currentPath.split('/') : [];
  const paths = [{ name: state.rootName, path: '' }];
  parts.forEach((name, index) => paths.push({ name, path: parts.slice(0, index + 1).join('/') }));

  paths.forEach((item, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'crumb-separator';
      separator.textContent = '/';
      elements.breadcrumbs.append(separator);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb';
    button.textContent = item.name;
    button.addEventListener('click', () => loadFolder(item.path));
    elements.breadcrumbs.append(button);
  });

  const selected = state.selected.has(state.currentPath);
  const covered = isCoveredBySelection(state.currentPath);
  elements.selectCurrent.textContent = selected ? '선택 해제' : covered ? '상위 폴더에 포함됨' : '이 폴더 선택';
  elements.selectCurrent.classList.toggle('active', selected || covered);
  elements.selectCurrent.disabled = covered && !selected;
}

function renderSelected() {
  elements.selectedList.replaceChildren();
  const selected = [...state.selected].sort((a, b) => a.localeCompare(b, 'ko-KR', { numeric: true }));
  elements.selectedCount.textContent = `${selected.length}개`;

  if (selected.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '아직 선택한 폴더가 없습니다.';
    elements.selectedList.append(empty);
    return;
  }

  for (const folder of selected) {
    const chip = document.createElement('div');
    chip.className = 'selected-chip';
    const label = document.createElement('span');
    label.textContent = displayPath(folder);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `${displayPath(folder)} 선택 해제`);
    remove.textContent = '×';
    remove.addEventListener('click', () => toggleSelection(folder));
    chip.append(label, remove);
    elements.selectedList.append(chip);
  }
}

async function loadFolder(folder) {
  elements.folderList.innerHTML = '<p class="empty">폴더를 불러오는 중입니다.</p>';
  try {
    const result = await api(`/api/folders?path=${encodeURIComponent(folder)}`);
    state.currentPath = result.currentPath;
    renderBreadcrumbs();
    elements.folderList.replaceChildren();

    if (result.folders.length === 0) {
      elements.folderList.innerHTML = '<p class="empty">하위 폴더가 없습니다. 현재 폴더를 선택할 수 있습니다.</p>';
      return;
    }

    for (const folderItem of result.folders) {
      const row = document.createElement('div');
      row.className = 'folder-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'folder-check';
      checkbox.checked = isCoveredBySelection(folderItem.path);
      checkbox.disabled = checkbox.checked && !state.selected.has(folderItem.path);
      checkbox.setAttribute('aria-label', `${folderItem.name} 선택`);
      checkbox.addEventListener('change', () => toggleSelection(folderItem.path));
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'folder-name';
      name.textContent = folderItem.name;
      name.addEventListener('click', () => loadFolder(folderItem.path));
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'folder-open';
      openButton.setAttribute('aria-label', `${folderItem.name} 열기`);
      openButton.textContent = '›';
      openButton.addEventListener('click', () => loadFolder(folderItem.path));
      row.append(checkbox, name, openButton);
      elements.folderList.append(row);
    }
  } catch (error) {
    elements.folderList.innerHTML = `<p class="empty">${error.message}</p>`;
  }
}

elements.selectCurrent.addEventListener('click', () => toggleSelection(state.currentPath));

elements.saveButton.addEventListener('click', async () => {
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = '사진 찾는 중…';
  elements.saveMessage.classList.remove('error');
  elements.saveMessage.textContent = '선택한 폴더의 JPG를 확인하고 있습니다.';
  try {
    const result = await api('/api/selection', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders: [...state.selected] })
    });
    state.selected = new Set(result.selectedFolders);
    renderSelected();
    await loadFolder(state.currentPath);
    elements.saveMessage.textContent = `저장했습니다. 현재 재생 대상은 ${result.photoCount.toLocaleString()}장입니다.`;
  } catch (error) {
    elements.saveMessage.classList.add('error');
    elements.saveMessage.textContent = error.message;
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.textContent = '선택 저장';
  }
});

async function initialize() {
  try {
    const config = await api('/api/config');
    state.rootName = config.rootName;
    state.selected = new Set(config.selectedFolders);
    elements.rootPath.textContent = config.rootPath;
    elements.serverDot.classList.add(config.rootAvailable ? 'online' : 'offline');
    elements.serverStatus.textContent = config.rootAvailable ? 'PC 서버 연결됨' : '사진 최상위 폴더를 찾을 수 없음';
    renderSelected();
    if (config.rootAvailable) await loadFolder('');
    else elements.folderList.innerHTML = '<p class="empty">PC에서 사진 폴더 경로를 확인해주세요.</p>';
  } catch (error) {
    elements.serverDot.classList.add('offline');
    elements.serverStatus.textContent = 'PC 서버에 연결할 수 없음';
    elements.rootPath.textContent = error.message;
  }
}

initialize();
refreshLocationStatus();
setInterval(refreshLocationStatus, 5000);
