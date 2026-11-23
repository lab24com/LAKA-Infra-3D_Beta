<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Clase principal del widget: nombre por defecto.
 */

namespace Modules\LakaInfra3D;

use Zabbix\Core\CWidget;

class Widget extends CWidget {

	public function getDefaultName(): string {
		return 'LAKA Infra 3D';
	}
}
