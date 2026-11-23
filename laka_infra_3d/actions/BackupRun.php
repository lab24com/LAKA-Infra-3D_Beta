<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Respaldo y restauración completos del módulo (solo Super admin):
 *  export  → archivo JSON con salas, cableado, sitios, mapa, modelos, permisos y, si se pide, fotos de modelos;
 *  preview → lee el archivo y muestra qué trae, sin guardar nada;
 *  apply   → restaura (reemplazar todo o combinar) pasando todo por los normalizadores del editor.
 */

namespace Modules\LakaInfra3D\Actions;

use APP,
	CController,
	CControllerResponseData;

use Modules\LakaInfra3D\Includes\{
	Backup,
	Config,
	History,
	I18n,
	Layout
};

class BackupRun extends CController {

	// Tope del archivo de respaldo recibido (las fotos van en base64).
	private const MAX_UPLOAD = 32 * 1024 * 1024;

	protected function checkInput(): bool {
		$fields = [
			'op' => 'required|in export,preview,apply',
			'images' => 'in 0,1',
			'mode' => 'in replace,merge',
			'data' => 'string',
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
		$module = APP::ModuleManager()->getModule(Layout::MODULE_ID);

		if ($loaded === null || $module === null) {
			$this->fail(I18n::t('El módulo no está habilitado.'));

			return;
		}

		[$moduleid, $config] = $loaded;
		$op = $this->getInput('op');

		if ($op === 'export') {
			$backup = Backup::build($config, $module->getVersion(), $this->getInput('images', '1') === '1');
			History::audit((string) $moduleid, [], I18n::t('Respaldo exportado'));

			$this->respond(['success' => true, 'backup' => $backup, 'summary' => Backup::summary($backup['config'], $backup['images'] ?? [])]);

			return;
		}

		$text = $this->getInput('data', '');

		if (strlen($text) > self::MAX_UPLOAD) {
			$this->fail(I18n::t('El archivo es demasiado grande.'));

			return;
		}

		[$backup, $error] = Backup::parse($text);

		if ($backup === null) {
			$this->fail($error);

			return;
		}

		$info = [
			'module_version' => (string) ($backup['module_version'] ?? ''),
			'zabbix_version' => (string) ($backup['zabbix_version'] ?? ''),
			'db' => (string) ($backup['db'] ?? ''),
			'exported' => (int) ($backup['exported'] ?? 0),
			'by' => (string) ($backup['by'] ?? '')
		];

		if ($op === 'preview') {
			// Tamaño estimado del resultado (sin crear fotos) para avisar antes si no entra en la base.
			[$draft] = Backup::restore(['config' => $backup['config']], $config, $this->getInput('mode', 'replace'));

			$this->respond([
				'success' => true,
				'info' => $info,
				'summary' => Backup::summary($backup['config'], $backup['images'] ?? []),
				'current' => Backup::summary($config),
				'storage' => Config::stats($draft)
			]);

			return;
		}

		[$restored, $created] = Backup::restore($backup, $config, $this->getInput('mode', 'replace'));

		$error = Config::save($moduleid, $restored, null, 'restore');

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		$this->respond([
			'success' => true,
			'images_created' => $created,
			'storage' => Config::stats($restored),
			'message' => I18n::t('Respaldo restaurado. Recarga la página para ver los cambios.')
		]);
	}

	private function fail(string $message): void {
		$this->respond(['error' => ['messages' => [$message]]]);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
