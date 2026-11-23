/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Integración con el tablero de Zabbix: recibe los datos del controlador, mantiene viva la
 * escena 3D entre refrescos, abre el editor de sala y envía el host seleccionado a los
 * widgets vinculados.
 */

class CWidgetLakaInfra3D extends CWidget {

	onInitialize() {
		this._scene = null;
		this._root = null;
		this._editor = null;
		this._response = null;
		this._sites = null;
		this._pendingSite = null;
		// Sala elegida en el navegador de sitios (null = la del campo "Sala" del widget).
		this._roomOverride = this._loadRoom();
	}

	_roomStorageKey() {
		return `laka3d.room.${this._widgetid || 'new'}`;
	}

	_loadRoom() {
		try {
			const value = window.localStorage.getItem(this._roomStorageKey());

			return value === null ? null : value;
		}
		catch (error) {
			return null;
		}
	}

	_saveRoom() {
		try {
			if (this._roomOverride === null) {
				window.localStorage.removeItem(this._roomStorageKey());
			}
			else {
				window.localStorage.setItem(this._roomStorageKey(), this._roomOverride);
			}
		}
		catch (error) {
			// Sin almacenamiento local: la sala elegida vale hasta recargar la página.
		}
	}

	/**
	 * Pide los datos de la sala elegida en el navegador de sitios sin cambiar la configuración del widget.
	 */
	getUpdateRequestData() {
		const data = super.getUpdateRequestData();

		if (this._roomOverride !== null) {
			data.fields = Object.assign({}, data.fields || {}, {room: this._roomOverride});
		}

		return data;
	}

	_setRoom(name) {
		const fieldRoom = (this.getFieldsData().room ?? '').trim();

		this._roomOverride = name.trim() === fieldRoom ? null : name.trim();
		this._saveRoom();
		this._closeEditor();

		// La sala cambia por completo: se arma de nuevo.
		this._destroyScene();
		this._body.innerHTML = '';
		this._startUpdating();
	}

	_openSites() {
		if (this._sites !== null || this._response === null || this._root === null
				|| typeof LakaInfra3DSites === 'undefined') {
			return;
		}

		this._sites = new LakaInfra3DSites(this._root, this._response, {
			onRoom: (name) => this._setRoom(name),
			onCreate: (site, name) => {
				this._pendingSite = site;
				this._setRoom(name);
			},
			onClose: () => {
				this._sites = null;
			}
		});
	}

	setContents(response) {
		// Error del controlador u otra respuesta con HTML: se muestra tal cual.
		if ('body' in response && !('devices' in response) && !('empty' in response)) {
			this._closeEditor();
			this._destroyScene();
			this._body.innerHTML = response.body;

			return;
		}

		this._response = response;

		// Con el editor abierto no se toca la pantalla vacía (el editor está encima).
		if (response.empty) {
			if (this._editor === null) {
				this._destroyScene();
				this._showEmpty(response);

				// Sala recién creada en el navegador de sitios: se abre el editor con su sitio.
				if (this._pendingSite !== null && response.editor) {
					response.editor.layout.site = this._pendingSite;
					this._pendingSite = null;
					this._openEditor('templates');
				}
			}

			return;
		}

		this._pendingSite = null;

		if (typeof window.LakaInfra3DThree === 'undefined') {
			this._body.textContent = 'LAKA Infra 3D: no se pudo cargar Three.js (laka-three.js).';

			return;
		}

		if (this._scene === null) {
			this._closeEditor();
			this._body.innerHTML = '';
			this._root = document.createElement('div');
			this._body.appendChild(this._root);

			try {
				this._scene = new LakaInfra3DScene(this._root, {
					onSelectHost: (hostid) => this._broadcastHost(hostid),
					onEdit: (tab) => this._openEditor(tab),
					onSites: () => this._openSites(),
					// Clave para recordar en este navegador la cobertura de cámaras y la grilla de este widget.
					prefsKey: `laka3d.view.${this._widgetid || 'new'}`
				});
			}
			catch (error) {
				this._scene = null;
				this._root = null;
				this._body.textContent = 'LAKA Infra 3D: WebGL no está disponible en este navegador.';
				console.error(error);

				return;
			}
		}

		this._scene.setData(response);

		if (this._state === WIDGET_STATE_ACTIVE) {
			this._scene.start();
		}
	}

	_broadcastHost(hostid) {
		try {
			this.broadcast({
				[CWidgetsData.DATA_TYPE_HOST_ID]: [hostid],
				[CWidgetsData.DATA_TYPE_HOST_IDS]: [hostid]
			});
		}
		catch (error) {
			console.error(error);
		}
	}

	_showEmpty(response) {
		const i18n = response.i18n || {};
		const t = (text) => i18n[text] || text;
		const tags = response.tags || {rack: 'rack', u: 'u', size: 'alto'};

		this._body.innerHTML = '';
		this._root = document.createElement('div');
		this._root.className = 'laka3d laka3d-empty-root';
		this._body.appendChild(this._root);

		const box = document.createElement('div');

		box.className = 'laka3d-empty';
		box.innerHTML = '<strong></strong><p></p><code></code><span class="laka3d-brand-inline">© LAKA Soluciones Tecnológicas</span>';
		box.querySelector('strong').textContent = t('No hay hosts con ubicación en rack.');
		box.querySelector('p').textContent = t('Agrega a cada host los tags de ubicación, por ejemplo:');
		box.querySelector('code').textContent = `${tags.rack}=R01   ${tags.u}=20   ${tags.size}=2`;

		// Navegador de sitios también en una sala vacía, para volver a otra sala.
		if ((response.sites || []).reduce((n, s) => n + s.rooms.length, 0) > 1 || response.editor) {
			const nav = document.createElement('button');

			nav.type = 'button';
			nav.className = 'laka3d-btn laka3d-site-btn';
			nav.textContent = `${response.site ? response.site + ' · ' : ''}${response.room || t('Sala principal')} ▾`;
			nav.addEventListener('click', () => this._openSites());
			box.insertBefore(nav, box.firstChild);
		}

		if (response.editor) {
			const p = document.createElement('p');
			const btn = document.createElement('button');

			p.textContent = t('O arma la sala con el editor:');
			btn.type = 'button';
			btn.className = 'laka3d-btn laka3d-btn-primary';
			btn.textContent = t('Crear sala');
			btn.addEventListener('click', () => this._openEditor('templates'));
			box.insertBefore(btn, box.lastElementChild);
			box.insertBefore(p, btn);
		}

		this._root.appendChild(box);
	}

	_openEditor(tab = 'room') {
		if (this._editor !== null || this._response === null || !this._response.editor
				|| typeof LakaInfra3DEditor === 'undefined') {
			return;
		}

		this._editor = new LakaInfra3DEditor(this._root, this._response, {
			onClose: (saved, message) => {
				this._editor = null;

				if (saved) {
					if (this._scene !== null) {
						this._scene.toast(message);
					}

					// Refresco inmediato para ver la sala nueva.
					this._startUpdating();
				}
				else if (this._response && this._response.empty) {
					this._showEmpty(this._response);
				}
			}
		});

		this._editor.tab = tab;
		this._editor.render();
	}

	_closeEditor() {
		if (this._editor !== null) {
			const editor = this._editor;

			this._editor = null;
			editor.cb = {};
			editor.close();
		}
	}

	onActivate() {
		if (this._scene !== null) {
			this._scene.start();
		}
	}

	onDeactivate() {
		if (this._scene !== null) {
			this._scene.stop();
		}
	}

	onResize() {
		if (this._scene !== null) {
			this._scene.resize();
		}
	}

	onClearContents() {
		this._closeEditor();
		this._destroyScene();
	}

	onDestroy() {
		this._closeEditor();
		this._destroyScene();
	}

	_destroyScene() {
		if (this._scene !== null) {
			this._scene.dispose();
			this._scene = null;
		}

		this._root = null;
	}

	hasPadding() {
		return false;
	}
}
