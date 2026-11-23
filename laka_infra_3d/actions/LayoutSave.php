<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Guarda la distribución de una sala hecha en el editor del widget.
 * Se guarda en la configuración del módulo (tabla module.config), con control de versiones
 * para no pisar los cambios que otro usuario haya guardado mientras tanto.
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	APP,
	CController,
	CControllerResponseData,
	CWebUser,
	DB;

use Modules\LakaInfra3D\Includes\{
	Config,
	History,
	I18n,
	Layout
};

class LayoutSave extends CController {

	protected function checkInput(): bool {
		$fields = [
			'room_key' => 'required|string',
			'layout' => 'required|string',
			'rev' => 'required|int32',
			'lang' => 'string'
		];

		$ret = $this->validateInput($fields);

		if (!$ret) {
			$this->respond(['error' => ['messages' => array_column(get_and_clear_messages(), 'message')]]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN;
	}

	protected function doAction(): void {
		$lang = $this->getInput('lang', 'es');
		I18n::setLanguage(['es' => I18n::LANG_ES, 'pt' => I18n::LANG_PT, 'en' => I18n::LANG_EN][$lang] ?? I18n::LANG_AUTO);

		$module = APP::ModuleManager()->getModule(Layout::MODULE_ID);

		if ($module === null) {
			$this->fail(I18n::t('El módulo no está habilitado.'));

			return;
		}

		$input = json_decode($this->getInput('layout'), true);

		if (!is_array($input)) {
			$this->fail(I18n::t('La distribución recibida no es válida.'));

			return;
		}

		$room_key = Layout::roomKey($this->getInput('room_key') === Layout::DEFAULT_ROOM
			? '' : $this->getInput('room_key')
		);

		// Configuración actual leída de la base de datos (comprimida o no), no de la caché del módulo.
		[, $config] = Config::load() ?? [null, []];
		$rooms = is_array($config['rooms'] ?? null) ? $config['rooms'] : [];

		// Permiso por sala: si la sala tiene grupos de usuarios asignados, solo ellos (y Super admin) la editan.
		if (!Config::canEditRoom($config, $room_key)) {
			$this->fail(I18n::t('No tienes permiso para editar esta sala.'));

			return;
		}

		$current_rev = (int) ($rooms[$room_key]['rev'] ?? 0);

		if ((int) $this->getInput('rev') !== $current_rev) {
			$this->fail(I18n::t('Otro usuario guardó cambios en esta sala. Recarga el widget y vuelve a intentarlo.'),
				['conflict' => true]
			);

			return;
		}

		$layout = Layout::normalize($input);
		$layout['rev'] = $current_rev + 1;
		$layout['updated'] = time();
		$layout['user'] = (string) (CWebUser::$data['username'] ?? CWebUser::$data['alias'] ?? '');

		$rooms[$room_key] = Layout::compact($layout);
		$config['rooms'] = $rooms;

		// Mismo guardado para MySQL / MariaDB y PostgreSQL (comprimido, con el tope de cada base).
		$error = Config::save($module->getModuleId(), $config,
			I18n::t('La configuración supera el límite de la base de datos de Zabbix (MySQL/MariaDB: 64 KB comprimidos). Quita cables, salas o sitios sin uso, o usa Zabbix sobre PostgreSQL.')
		);

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		$this->respond([
			'success' => true,
			'rev' => $layout['rev'],
			'storage' => Config::stats($config),
			'history' => History::forClient($config, $room_key),
			'message' => I18n::t('Distribución guardada.')
		]);
	}

	private function fail(string $message, array $extra = []): void {
		$this->respond(['error' => ['messages' => [$message]]] + $extra);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
