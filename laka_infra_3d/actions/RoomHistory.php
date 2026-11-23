<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Historial de cambios de una sala (quién, cuándo, qué) y "deshacer el último cambio".
 * El deshacer respeta el permiso por sala y queda también en el registro de auditoría de Zabbix.
 */

namespace Modules\LakaInfra3D\Actions;

use CController,
	CControllerResponseData;

use Modules\LakaInfra3D\Includes\{
	Config,
	History,
	I18n,
	Layout
};

class RoomHistory extends CController {

	protected function init(): void {
		// La lista se puede pedir por GET (solo lectura); deshacer exige POST con token CSRF.
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$fields = [
			'op' => 'required|in list,undo',
			'room_key' => 'required|string',
			'id' => 'string',
			'lang' => 'string',
			'_csrf_token' => 'string'
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

		$loaded = Config::load();

		if ($loaded === null) {
			$this->fail(I18n::t('El módulo no está habilitado.'));

			return;
		}

		[$moduleid, $config] = $loaded;
		$raw = $this->getInput('room_key');
		$scope = $raw === History::GLOBAL_KEY ? History::GLOBAL_KEY : Layout::roomKey($raw === Layout::DEFAULT_ROOM ? '' : $raw);

		if ($this->getInput('op') === 'list') {
			$this->respond(['success' => true, 'history' => History::forClient($config, $scope)]);

			return;
		}

		// Deshacer: POST con el token de esta acción.
		if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !$this->checkToken()) {
			$this->fail(I18n::t('La sesión expiró. Recarga la página.'));

			return;
		}

		$allowed = $scope === History::GLOBAL_KEY
			? $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN
			: Config::canEditRoom($config, $scope);

		if (!$allowed) {
			$this->fail(I18n::t('No tienes permiso para editar esta sala.'));

			return;
		}

		$error = History::undo($config, $scope, $this->getInput('id', ''));

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		$error = Config::save($moduleid, $config, null, 'undo', sprintf(I18n::t('Cambio deshecho en %1$s'),
			$scope === History::GLOBAL_KEY ? I18n::t('General') : $scope
		));

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		$this->respond([
			'success' => true,
			'history' => History::forClient($config, $scope),
			'storage' => Config::stats($config),
			'message' => I18n::t('Cambio deshecho. Recarga el widget para verlo.')
		]);
	}

	private function checkToken(): bool {
		return class_exists('CCsrfTokenHelper')
			&& \CCsrfTokenHelper::check((string) $this->getInput('_csrf_token', ''), 'laka_infra_3d.room.history');
	}

	private function fail(string $message): void {
		$this->respond(['error' => ['messages' => [$message]]]);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
