<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Guarda la ubicación en el mapa (latitud y longitud) de un sitio o región, por ejemplo
 * "Data center La Paz". Se guarda en la configuración del módulo (module.config → sites).
 * Sin latitud ni longitud, borra la ubicación guardada y el mapa vuelve a la sugerida.
 * Con map_country / map_scope guarda el enfoque del mapa de sitios (module.config → map):
 * país resaltado (ISO alfa-2, vacío = mundo) y alcance (país o ciudad).
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	APP,
	CController,
	CControllerResponseData,
	DB;

use Modules\LakaInfra3D\Includes\{
	Config,
	I18n,
	Layout
};

class SiteSave extends CController {

	// Sitios con ubicación guardada como máximo.
	private const MAX_SITES = 500;

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'site' => 'string',
			'map_country' => 'string',
			'map_scope' => 'in country,city,world',
			'lat' => 'string',
			'lon' => 'string',
			'lang' => 'string'
		]);

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

		$map_mode = $this->hasInput('map_country') || $this->hasInput('map_scope');
		$site = mb_substr(trim($this->getInput('site', '')), 0, 64);

		if (!$map_mode && $site === '') {
			$this->fail(I18n::t('La ubicación no es válida.'));

			return;
		}

		$country = strtoupper(trim($this->getInput('map_country', '')));

		if ($map_mode && $country !== '' && (!preg_match('/^[A-Z]{2}$/', $country)
				|| !is_file(dirname(__DIR__).'/data/geo/'.$country.'.json'))) {
			$this->fail(I18n::t('El país elegido no es válido.'));

			return;
		}

		$lat = trim($this->getInput('lat', ''));
		$lon = trim($this->getInput('lon', ''));
		$clear = $lat === '' && $lon === '';

		if (!$clear && (!is_numeric($lat) || !is_numeric($lon) || abs((float) $lat) > 90 || abs((float) $lon) > 180)) {
			$this->fail(I18n::t('La ubicación no es válida.'));

			return;
		}

		// Configuración actual leída de la base de datos (comprimida o no), no de la caché del módulo.
		[, $config] = Config::load() ?? [null, []];
		$sites = is_array($config['sites'] ?? null) ? $config['sites'] : [];

		if ($map_mode) {
			$config['map'] = ['country' => $country, 'scope' => $this->getInput('map_scope', 'country')];
		}
		elseif ($clear) {
			unset($sites[$site]);
		}
		else {
			$sites[$site] = ['lat' => round((float) $lat, 5), 'lon' => round((float) $lon, 5)];
		}

		if (!$map_mode) {
			$config['sites'] = array_slice($sites, 0, self::MAX_SITES, true);
		}

		$error = Config::save($module->getModuleId(), $config,
			I18n::t('La configuración supera el límite de la base de datos de Zabbix (MySQL/MariaDB: 64 KB comprimidos). Quita cables, salas o sitios sin uso, o usa Zabbix sobre PostgreSQL.')
		);

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		if ($map_mode) {
			$this->respond(['success' => true, 'map' => $config['map'], 'message' => I18n::t('Mapa guardado.')]);

			return;
		}

		$this->respond([
			'success' => true,
			'site' => $site,
			'coords' => $clear ? null : $sites[$site],
			'message' => $clear ? I18n::t('Ubicación quitada.') : I18n::t('Ubicación guardada.')
		]);
	}

	private function fail(string $message): void {
		$this->respond(['error' => ['messages' => [$message]]]);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
