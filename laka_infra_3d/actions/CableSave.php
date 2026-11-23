<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Cableado de la sala: cables de red (cobre o fibra) y de energía entre puertos de equipos, patch panels
 * y PDU. Se guarda en la configuración del módulo (module.config → cables → sala), aparte de la distribución,
 * así guardar la sala en el editor no borra el cableado.
 *
 * Cada cable: "extremoA|extremoB|tipo|etiqueta|color|largo_m". Un extremo es "equipo#puerto":
 * - equipo: id del host de Zabbix, "p:rack:U:cara" para un pasivo, "v:rack:A" para una PDU vertical
 *   u "o:ID" para una toma de área de trabajo o salida de zona (por ejemplo o:1A-W01-05);
 * - puerto: "F-rj45-5" (cara F frente / R atrás, tipo, número).
 * Un puerto lleva un solo cable: al conectar, se quita el cable anterior de ese puerto.
 * También guarda el identificador del espacio (FS) de la norma ANSI/TIA-606, la configuración de cada patch
 * panel (medio, categoría, conector, terminación, puertos, forma y función según ANSI/TIA-942), la de cada
 * equipo (papel y flujo de aire) y el estado de los puertos (reservado, dañado).
 * "replace" guarda todo junto desde el editor de sala y controla la versión (rev) para no pisar a otro usuario.
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

class CableSave extends CController {

	public const MAX_CABLES = 3000;
	public const KINDS = ['net', 'fiber', 'power'];

	// Equipo de un extremo: host, pasivo, PDU vertical, toma de área de trabajo o elemento de la sala
	// (cámara, control de acceso, sensor…: "x:" + id del elemento).
	private const DEVICE = '(\d{1,20}|p:[^|#]{1,40}:\d{1,3}:(front|back)|v:[^|#]{1,40}:[A-H]|o:[0-9A-Za-z.\-]{1,40}|x:[0-9A-Za-z_\-]{1,16})';

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'room_key' => 'required|string',
			'op' => 'required|in set,del,fs,replace',
			'data' => 'string',
			'rev' => 'int32',
			'len' => 'string',
			'a' => 'string',
			'b' => 'string',
			'k' => 'string',
			'l' => 'string',
			'c' => 'string',
			'fs' => 'string',
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

		$room_key = Layout::roomKey($this->getInput('room_key') === Layout::DEFAULT_ROOM ? '' : $this->getInput('room_key'));
		$all = is_array($config['cables'] ?? null) ? $config['cables'] : [];
		$room = self::normalize($all[$room_key] ?? []);
		$op = $this->getInput('op');

		// Permiso por sala: el cableado sigue los mismos grupos de usuarios que la distribución.
		if (!Config::canEditRoom($config, $room_key)) {
			$this->fail(I18n::t('No tienes permiso para editar esta sala.'));

			return;
		}

		if ($op === 'replace') {
			$data = json_decode($this->getInput('data', ''), true);

			if (!is_array($data)) {
				$this->fail(I18n::t('El cableado recibido no es válido.'));

				return;
			}

			if ((int) $this->getInput('rev', 0) !== (int) $room['rev']) {
				$this->fail(I18n::t('Otro usuario cambió el cableado de esta sala. Recarga el widget y vuelve a intentarlo.'));

				return;
			}

			$data['rev'] = $room['rev'];
			$room = self::normalize($data);

			if (count($room['list']) > self::MAX_CABLES) {
				$this->fail(I18n::t('La sala ya tiene el máximo de cables.'));

				return;
			}
		}
		elseif ($op === 'fs') {
			$fs = strtoupper(preg_replace('/[^0-9A-Za-z]/', '', $this->getInput('fs', '')));
			$room['fs'] = mb_substr($fs, 0, 8);
		}
		else {
			$a = self::endpoint($this->getInput('a', ''));

			if ($a === null) {
				$this->fail(I18n::t('El puerto no es válido.'));

				return;
			}

			// Quita el cable que ya use este puerto (y, al conectar, el que use el otro extremo).
			$b = $op === 'set' ? self::endpoint($this->getInput('b', '')) : null;

			if ($op === 'set' && ($b === null || $b === $a)) {
				$this->fail(I18n::t('El puerto no es válido.'));

				return;
			}

			$room['list'] = array_values(array_filter($room['list'], static function (string $cable) use ($a, $b): bool {
				[$ca, $cb] = explode('|', $cable);

				return !in_array($ca, [$a, $b], true) && !in_array($cb, [$a, $b], true);
			}));

			if ($op === 'set') {
				$kind = in_array($this->getInput('k', ''), self::KINDS, true) ? $this->getInput('k') : 'net';
				$label = mb_substr(trim(str_replace(['|', "\n", "\r"], ' ', $this->getInput('l', ''))), 0, 80);
				$color = preg_match('/^#[0-9a-fA-F]{6}$/', $this->getInput('c', '')) ? strtolower($this->getInput('c')) : '';

				if (count($room['list']) >= self::MAX_CABLES) {
					$this->fail(I18n::t('La sala ya tiene el máximo de cables.'));

					return;
				}

				$len = self::length($this->getInput('len', ''));
				$room['list'][] = implode('|', [$a, $b, $kind, $label, $color, $len]);
			}
		}

		$room['rev'] = (int) $room['rev'] + 1;
		$all[$room_key] = $room;
		$config['cables'] = $all;

		$error = Config::save($moduleid, $config);

		if ($error !== null) {
			$this->fail($error);

			return;
		}

		$this->respond([
			'success' => true,
			'cabling' => $room,
			'storage' => Config::stats($config),
			'history' => History::forClient($config, $room_key),
			'message' => $op === 'del' ? I18n::t('Cable quitado.') : ($op === 'fs' ? I18n::t('Identificador guardado.') : I18n::t('Cable guardado.'))
		]);
	}

	/** Cableado de una sala con el formato esperado (también limpia lo que llega del editor). */
	public static function normalize($room): array {
		$room = is_array($room) ? $room : [];
		$list = [];

		foreach (is_array($room['list'] ?? null) ? $room['list'] : [] as $cable) {
			if (!is_string($cable)) {
				continue;
			}

			$f = explode('|', $cable);

			if (count($f) < 5 || count($f) > 6) {
				continue;
			}

			$a = self::endpoint($f[0]);
			$b = self::endpoint($f[1]);

			if ($a === null || $b === null || $a === $b) {
				continue;
			}

			$list[] = implode('|', [$a, $b, in_array($f[2], self::KINDS, true) ? $f[2] : 'net',
				mb_substr(trim($f[3]), 0, 80), preg_match('/^#[0-9a-fA-F]{6}$/', $f[4]) ? strtolower($f[4]) : '',
				self::length($f[5] ?? '')
			]);
		}

		$map = static function ($value, callable $key_ok, string $pattern, int $max = 4000): array {
			$out = [];

			foreach (is_array($value) ? $value : [] as $k => $v) {
				// json_decode convierte en número las claves de hosts ("10084"): se vuelven a texto.
				$k = (string) $k;

				if (is_string($v) && $key_ok($k) && preg_match($pattern, $v)) {
					$out[$k] = $v;
				}

				if (count($out) >= $max) {
					break;
				}
			}

			return $out;
		};
		$is_device = static fn(string $k): bool => (bool) preg_match('/^'.self::DEVICE.'$/u', $k);
		$is_port = static fn(string $k): bool => self::endpoint($k) === $k;

		return [
			'fs' => is_string($room['fs'] ?? null) ? mb_substr(strtoupper(preg_replace('/[^0-9A-Za-z]/', '', $room['fs'])), 0, 8) : '',
			'rev' => (int) ($room['rev'] ?? 0),
			'list' => $list,
			// medio|categoría|conector|terminación|puertos|forma|función
			'panels' => $map($room['panels'] ?? [], $is_device,
				'/^(cu|stp|mm|sm)\|[0-9A-Za-z]{1,4}\|[A-Z0-9]{2,6}\|[A-Z]{3}\|\d{1,2}\|(flat|angled)\|(bb|hz|eq|er|zd)$/'
			),
			// papel|flujo de aire
			'devs' => $map($room['devs'] ?? [], $is_device, '/^[a-z]{0,10}\|(fb|bf|side)$/'),
			// Cadena eléctrica: rama (A–D)|alimentado desde (hasta dos fuentes, separadas por coma)
			'pw' => $map($room['pw'] ?? [], $is_device,
				'/^[A-D]?\|('.self::DEVICE.'(,'.self::DEVICE.')?)?$/u'
			),
			// estado|nota
			'ports' => array_map(static fn(string $v): string => mb_substr($v, 0, 64),
				$map($room['ports'] ?? [], $is_port, '/^(r|d)?\|[^\n\r]{0,120}$/u')
			)
		];
	}

	/** Largo del cable en metros (0,1 a 999,9) o vacío. */
	private static function length($value): string {
		$value = str_replace(',', '.', trim((string) $value));

		return is_numeric($value) && (float) $value > 0 ? (string) round(min(999.9, (float) $value), 1) : '';
	}

	/** Extremo válido "equipo#puerto" o null. */
	private static function endpoint(string $value): ?string {
		$value = trim($value);

		return preg_match('/^'.self::DEVICE.'#[FR]-[a-z0-9]{2,8}-\d{1,3}$/u', $value) ? $value : null;
	}

	private function fail(string $message): void {
		$this->respond(['error' => ['messages' => [$message]]]);
	}

	private function respond(array $output): void {
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
