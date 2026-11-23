<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Permiso de edición por sala: grupos de usuarios de Zabbix que pueden editar la distribución y el cableado.
 * Sin grupos, cualquier Administrador edita (como antes). Solo un Super admin cambia este permiso.
 * Se guarda en module.config → acl[sala] = [usrgrpid, ...].
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData;

use Modules\LakaInfra3D\Includes\{
	Config,
	I18n,
	Layout
};

class RoomAcl extends CController {

	private const MAX_GROUPS = 50;

	protected function checkInput(): bool {
		$fields = [
			'room_key' => 'required|string',
			'usrgrpids' => 'array_id',
			'lang' => 'string'
		];

		$ret = $this->validateInput($fields);

		if (!$ret) {
			$this->respond(['error' => ['messages' => array_column(get_and_clear_messages(), 'message')]]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	protected function doAction(): void {
		$lang = $this->getInput('lang', 'es');
		I18n::setLanguage(['es' => I18n::LANG_ES, 'pt' => I18n::LANG_PT, 'en' => I18n::LANG_EN][$lang] ?? I18n::LANG_AUTO);

		$loaded = Config::load();

		if ($loaded === null) {
			$this->fail(I18n::t('El módulo no está habilitado.'));

			return;
		}

		[$moduleid, $config] = $loaded;
		$room_key = Layout::roomKey($this->getInput('room_key') === Layout::DEFAULT_ROOM ? '' : $this->getInput('room_key'));
		$ids = array_slice(array_values(array_unique(array_map('strval', $this->getInput('usrgrpids', [])))), 0, self::MAX_GROUPS);

		// Solo grupos que existen en este Zabbix.
		if ($ids) {
			$ids = array_column(API::UserGroup()->get(['output' => ['usrgrpid'], 'usrgrpids' => $ids]), 'usrgrpid');
			$ids = array_map('strval', $ids);
		}

		$acl = is_array($config['acl'] ?? null) ? $config['acl'] : [];

		if ($ids) {
			$acl[$room_key] = $ids;
		}
		else {
			unset($acl[$room_key]);
		}

		if ($acl) {
			$config['acl'] = $acl;
		}
		else {
			unset($config['acl']);
		}

		$error = Config::save($moduleid, $config);

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		$this->respond([
			'success' => true,
			'editors' => $ids,
			'message' => $ids
				? I18n::t('Solo los grupos elegidos (y Super admin) pueden editar esta sala.')
				: I18n::t('Cualquier Administrador puede editar esta sala.')
		]);
	}

	private function fail(string $message): void {
		$this->respond(['error' => ['messages' => [$message]]]);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
