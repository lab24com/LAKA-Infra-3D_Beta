<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Contorno de un país para el mapa de sitios: lee data/geo/XX.json (Natural Earth 1:50m, dominio público)
 * y lo entrega tal cual. Solo se pide el país elegido, así el navegador no descarga el mundo entero.
 */

namespace Modules\LakaInfra3D\Actions;

use CController,
	CControllerResponseData;

class GeoCountry extends CController {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput(['country' => 'required|string']);

		if (!$ret) {
			$this->respond(['error' => ['messages' => ['country']]]);
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_USER;
	}

	protected function doAction(): void {
		$code = strtoupper(trim($this->getInput('country')));
		$file = dirname(__DIR__).'/data/geo/'.$code.'.json';

		// Solo códigos de dos letras: nada de rutas armadas con lo que manda el navegador.
		if (!preg_match('/^[A-Z]{2}$/', $code) || !is_file($file)) {
			$this->respond(['error' => ['messages' => ['country']]]);

			return;
		}

		$this->setResponse(new CControllerResponseData(['main_block' => (string) file_get_contents($file)]));
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output)]));
	}
}
