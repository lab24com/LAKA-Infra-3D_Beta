<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Perfil de hardware de un modelo de equipo: qué tiene en el frente y atrás (puertos RJ45 y SFP, consola,
 * gestión, USB, discos, fuentes de poder, ventiladores, tomas) y las fotos del frente y de atrás.
 * - El perfil se guarda en la configuración del módulo (module.config → models), uno por modelo:
 *   todos los equipos del mismo fabricante y modelo (inventario de Zabbix) lo comparten.
 * - Las fotos se guardan con la API de imágenes de Zabbix (Administración → General → Imágenes, tipo fondo),
 *   que solo permite crear imágenes a un superadministrador. Tamaño: 1200 px de ancho y 111 px por U
 *   (proporción de un equipo de 19": 482,6 mm × 44,45 mm por U).
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData,
	CWebUser;

use Modules\LakaInfra3D\Includes\{
	Config,
	I18n
};

class ModelSave extends CController {

	public const MAX_MODELS = 500;
	public const IMAGE_WIDTH = 1200;
	public const IMAGE_U = 111;

	// Componentes que puede tener cada cara.
	public const PARTS = ['rj45', 'sfp', 'console', 'mgmt', 'usb', 'vga', 'disk', 'psu', 'fan', 'outlet', 'pp'];

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'mkey' => 'required|string',
			'name' => 'string',
			'profile' => 'string',
			'n' => 'int32',
			'front' => 'string',
			'back' => 'string',
			'clear_front' => 'in 0,1',
			'clear_back' => 'in 0,1',
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

		$loaded = Config::load();

		if ($loaded === null) {
			$this->fail(I18n::t('El módulo no está habilitado.'));

			return;
		}

		[$moduleid, $config] = $loaded;

		$mkey = mb_substr(trim($this->getInput('mkey')), 0, 128);

		if ($mkey === '') {
			$this->fail(I18n::t('El modelo no es válido.'));

			return;
		}

		$models = is_array($config['models'] ?? null) ? $config['models'] : [];
		$model = is_array($models[$mkey] ?? null) ? $models[$mkey] : [];
		$n = max(1, min(20, (int) $this->getInput('n', $model['n'] ?? 1)));

		if ($this->hasInput('profile')) {
			$profile = self::profile($this->getInput('profile'));

			if ($profile === '') {
				unset($model['p']);
			}
			else {
				$model['p'] = $profile;
			}
		}

		$super = CWebUser::getType() == USER_TYPE_SUPER_ADMIN;
		$label = mb_substr(trim($this->getInput('name', $mkey)), 0, 40);

		foreach (['front' => 'f', 'back' => 'b'] as $side => $field) {
			$clear = $this->getInput('clear_'.$side, '0') === '1';
			$data = $this->getInput($side, '');

			if (!$clear && $data === '') {
				continue;
			}

			if (!$super) {
				$this->fail(I18n::t('Solo un superadministrador puede subir o quitar fotos: Zabbix guarda las imágenes con su API de imágenes.'));

				return;
			}

			$name = 'LAKA3D '.substr(md5($mkey), 0, 8).' '.($side === 'front' ? 'F' : 'R').' '.$label;
			$name = mb_substr($name, 0, 64);

			if ($clear) {
				if (!empty($model[$field])) {
					try {
						API::Image()->delete([$model[$field]]);
					}
					catch (\Exception $e) {
						// La imagen ya no existe: solo se quita la referencia.
					}
				}

				unset($model[$field]);
				continue;
			}

			$error = self::checkImage($data, $n);

			if ($error !== null) {
				$this->fail($error);

				return;
			}

			$imageid = $model[$field] ?? null;
			$exists = $imageid ? API::Image()->get(['output' => ['imageid'], 'imageids' => [$imageid]]) : [];

			$result = $exists
				? API::Image()->update([['imageid' => $imageid, 'image' => $data]])
				: API::Image()->create([['name' => $name.' '.substr(uniqid(), -4), 'imagetype' => IMAGE_TYPE_BACKGROUND,
					'image' => $data
				]]);

			if (!$result || empty($result['imageids'])) {
				$messages = array_column(get_and_clear_messages(), 'message');
				$this->fail($messages ? implode("\n", $messages) : I18n::t('No se pudo guardar la imagen.'));

				return;
			}

			$model[$field] = (string) $result['imageids'][0];
		}

		if ($model) {
			$model['n'] = $n;
			$models[$mkey] = $model;
		}
		else {
			unset($models[$mkey]);
		}

		if (count($models) > self::MAX_MODELS) {
			$this->fail(I18n::t('Se alcanzó el máximo de modelos guardados.'));

			return;
		}

		$config['models'] = $models;

		$error = Config::save($moduleid, $config);

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		$this->respond([
			'success' => true,
			'mkey' => $mkey,
			'model' => $models[$mkey] ?? null,
			'message' => I18n::t('Perfil del modelo guardado.')
		]);
	}

	/**
	 * Perfil compacto validado: "F:rj45=24,sfp=4,console=1;R:psu=2,fan=2". Vacío = usar el perfil por defecto.
	 */
	public static function profile(string $value): string {
		$out = [];

		foreach (explode(';', $value) as $face) {
			if (!preg_match('/^([FR]):(.*)$/', trim($face), $m)) {
				continue;
			}

			$parts = [];

			foreach (explode(',', $m[2]) as $part) {
				if (preg_match('/^([a-z0-9]+)=(\d{1,3})$/', trim($part), $p) && in_array($p[1], self::PARTS, true)) {
					$parts[] = $p[1].'='.min(96, (int) $p[2]);
				}
			}

			$out[$m[1]] = $m[1].':'.implode(',', $parts);
		}

		ksort($out);

		return implode(';', $out);
	}

	/**
	 * La foto llega en base64 (PNG o JPEG) ya ajustada en el navegador al tamaño definido.
	 */
	private static function checkImage(string $data, int $n): ?string {
		$raw = base64_decode($data, true);

		if ($raw === false || strlen($raw) > ZBX_MAX_IMAGE_SIZE) {
			return I18n::t('La imagen no es válida o pesa más de 1 MB.');
		}

		$size = @getimagesizefromstring($raw);

		if ($size === false || !in_array($size[2], [IMAGETYPE_PNG, IMAGETYPE_JPEG], true)) {
			return I18n::t('La imagen debe ser PNG o JPEG.');
		}

		if ($size[0] !== self::IMAGE_WIDTH || abs($size[1] - self::IMAGE_U * $n) > 2) {
			return sprintf(I18n::t('La imagen debe medir %1$s × %2$s px.'), self::IMAGE_WIDTH, self::IMAGE_U * $n);
		}

		return null;
	}

	private function fail(string $message): void {
		$this->respond(['error' => ['messages' => [$message]]]);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
