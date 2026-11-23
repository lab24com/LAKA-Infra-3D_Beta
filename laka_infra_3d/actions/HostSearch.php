<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Búsqueda de grupos de hosts y de hosts para el editor de sala, igual que los selectores de Zabbix:
 * por nombre (técnico o visible) y filtrando por uno o varios grupos. Respeta los permisos del usuario.
 */

namespace Modules\LakaInfra3D\Actions;

use API,
	CController,
	CControllerResponseData;

use Modules\LakaInfra3D\Includes\Layout;

class HostSearch extends CController {

	private const LIMIT = 200;

	protected function init(): void {
		// Solo lectura: no hace falta token CSRF.
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput([
			'what' => 'required|in groups,hosts',
			'search' => 'string',
			'groupid' => 'id',
			'groupids' => 'array_id',
			'limit' => 'int32'
		]);

		if (!$ret) {
			$this->setResponse(new CControllerResponseData(['main_block' => json_encode(['error' => true])]));
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() >= USER_TYPE_ZABBIX_ADMIN;
	}

	protected function doAction(): void {
		$search = trim($this->getInput('search', ''));
		// Las sugerencias piden pocos resultados; la lista completa, hasta LIMIT.
		$limit = max(1, min(self::LIMIT, (int) $this->getInput('limit', self::LIMIT)));

		if ($this->getInput('what') === 'groups') {
			$options = [
				'output' => ['groupid', 'name'],
				'with_monitored_hosts' => true,
				'sortfield' => 'name',
				'limit' => $limit
			];

			if ($search !== '') {
				$options['search'] = ['name' => $search];
			}

			$groups = API::HostGroup()->get($options);

			$output = ['groups' => array_map(static fn(array $g): array => [
				'id' => (string) $g['groupid'],
				'name' => $g['name']
			], $groups)];
		}
		else {
			$options = [
				'output' => ['hostid', 'host', 'name'],
				'selectInventory' => ['type'],
				'monitored_hosts' => true,
				'sortfield' => 'name',
				'limit' => $limit
			];

			if ($search !== '') {
				$options['search'] = ['host' => $search, 'name' => $search];
				$options['searchByAny'] = true;
			}

			$groupids = $this->getInput('groupids', []);

			if ($this->hasInput('groupid')) {
				$groupids[] = $this->getInput('groupid');
			}

			if ($groupids) {
				$options['groupids'] = array_values(array_unique($groupids));
			}

			$hosts = API::Host()->get($options);

			$output = ['hosts' => array_map(static fn(array $h): array => [
				'id' => (string) $h['hostid'],
				'name' => $h['name'],
				'host' => $h['host'],
				'type' => Layout::normalizeType('', $h['host'].' '.$h['name'].' '
					.(is_array($h['inventory']) ? ($h['inventory']['type'] ?? '') : '')
				)
			], $hosts)];
		}

		$output['limit'] = $limit;

		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($output, JSON_UNESCAPED_UNICODE)]));
	}
}
