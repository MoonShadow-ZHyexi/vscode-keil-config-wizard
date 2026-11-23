// <<< Use Configuration Wizard in Context Menu >>>
// <h> 串口
// <q> 启用串口
#define UART_ENABLE 1
// <o> 波特率
// <9600=> 9600
// <115200=> 115200
#define UART_BAUD 115200
// <o.4..5> 校验模式
// <0=> 无
// <1=> 奇校验
// <2=> 偶校验
#define UART_FLAGS 0xA0
// <o> 二进制掩码
#define UART_MASK 0b00000011U
// <s.16> 设备名称
#define DEVICE_NAME "BOARD"
// <o> 调试模式
// <0=> 关闭
// <1=> 文本
// <2=> 二进制
#define UART_DEBUG_MODE 1
// <z> 调试参数
// <if> UART_ENABLE && UART_DEBUG_MODE == 1
// <s.16> 文本日志前缀
#define UART_LOG_PREFIX "UART"
// <elif> UART_ENABLE && UART_DEBUG_MODE == 2
// <o> 二进制日志掩码
#define UART_LOG_MASK 0xFF
// <else>
// <q> 调试关闭时闪灯
#define UART_DEBUG_LED 0
// <endif>
// </z>
// </h>

// <h> Keil 与 CMSIS-Pack 兼容示例
// <i> 本分组覆盖源码换算、按名绑定、默认值和代码块开关。
// <n> 点击「恢复默认」可恢复该项。原有字面量的进制和后缀会保留。

// <e EXAMPLE_ENABLE> 按名绑定分组开关
// <i> 取消勾选后，子项置灰。重新勾选可继续编辑原有值。
// <d> 1
#define EXAMPLE_ENABLE 1

// <q.0 EXAMPLE_FLAGS> 使能接收中断
// <i> 只修改第 0 位，其余位保持原样。
// <d> 1
#define EXAMPLE_FLAGS 0b00000011U

// <o EXAMPLE_LEVEL> 数字下拉框 <0=> 关闭 <1=> 低 <2=> 高
// <d> 1
#define EXAMPLE_LEVEL 2

// 标识符选项会写入下面的宏名，可以跳过中间无关的声明。
// <o EXAMPLE_IO_MODE> 传输方式 <EXAMPLE_POLLING=> 轮询 <EXAMPLE_DMA=> DMA
// <d> EXAMPLE_POLLING
enum { EXAMPLE_POLLING = 0, EXAMPLE_DMA = 1 };
#define EXAMPLE_IO_MODE EXAMPLE_DMA

// <y EXAMPLE_QUEUE_LIMIT> 队列容量 <1..64>
// <i> 可输入整数或符号。例如 16、EXAMPLE_DEFAULT_LIMIT。
// <d> EXAMPLE_DEFAULT_LIMIT
#define EXAMPLE_DEFAULT_LIMIT 12
#define EXAMPLE_QUEUE_LIMIT 16

// <s.12 EXAMPLE_LABEL> 指定名称的字符串
// <d> "CONSOLE"
#define EXAMPLE_LABEL "UART"

// <o EXAMPLE_TEMP_OFFSET> 温度偏移（摄氏度） <-50..100:10>
// <d> -10
#define EXAMPLE_TEMP_OFFSET (-20)

// 界面输入 200，除以 4 后存储 50。
// <o EXAMPLE_STACK_WORDS> 堆栈大小（字节） <64..4096:8><#/4><f.d>
// <d> 200
#define EXAMPLE_STACK_WORDS 0x32U

// 位域先换算再合并，其余位保留。源码低 3 位存储 2，界面显示 3。
// <o.0..2 EXAMPLE_COUNT_BITS> 一基计数 <1..8><#-1>
// <d> 3
#define EXAMPLE_COUNT_BITS 0xA2U

// <o EXAMPLE_BIASED> 加法换算 <0..15><#+1>
#define EXAMPLE_BIASED 4

// <o EXAMPLE_BITS> 乘法换算 <0..16><#*8><f.b>
#define EXAMPLE_BITS 0x20U

// <o EXAMPLE_OCTAL> 指定八进制显示 <f.o>
#define EXAMPLE_OCTAL 16U

// <a.4 EXAMPLE_BYTES> 四元素数组 <0..255><f.h>
// <i> 以逗号分隔。数组长度、元素范围和步长都会校验。
// <d> {0x00, 0x01, 0x02, 0x03}
static const unsigned char EXAMPLE_BYTES[4] = {
    0x00, 0x10, /* 阈值 */ 0x20, 0x30
};

// <a.2> 自动绑定后面的两个整数阈值 <0..100:5>
// <d> {20, 80}
static const unsigned char example_thresholds[2] = { 25, 75 };
// </e>

// <c> 启用诊断
// <d> 0
#define EXAMPLE_DIAGNOSTICS 1
// </c>

// <c1> 启用两条调试定义
// <i> 跳过本说明行。取消勾选会注释以下两条定义。
#define EXAMPLE_TRACE_ON 1
#define EXAMPLE_TRACE_LEVEL 2
// </c>

// <!c> 关闭统计
// <i> 勾选时注释该定义，取消勾选时恢复。
#define EXAMPLE_COLLECT_STATS 1
// </c>
// </h>

// <<< end of configuration section >>>
